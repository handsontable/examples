// index.js

// Load local secrets / config from .env (GITHUB_TOKEN, REDIS_URL, CSB_API_KEY, …).
// Uses Node 22's built-in loader — no dotenv dependency. The file is optional:
// in production environments (Render, Docker) real env vars are injected by the
// platform and this call is a no-op.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
for (const envFile of [".env.local", ".env"]) {
  const p = path.join(__dirname, envFile);
  if (fs.existsSync(p)) {
    try {
      process.loadEnvFile(p);
    } catch (err) {
      console.warn(`[env] failed to load ${envFile}:`, err?.message || err);
    }
  }
}

import express from "express";
import { CodeSandbox, CommandError } from "@codesandbox/sdk";
import { Octokit } from "octokit";
import { fetchFiles } from "./github.js";
import { getVersion } from "./version.js";
import { validateHandsontableVersionParam } from "./validate-handsontable-version.js";
import {
  validateQueryParamsSync,
  validateExampleDirExistsInRepo,
} from "./validate-query-params.js";
import { pkgPrNewDependencyUrl } from "./pkg-pr-new.js";
import {
  shouldNotifySlack,
  isCodesandboxUnavailableError,
  CODESANDBOX_STATUS_URL,
} from "./slack-notify.js";
import { createCacheStore } from "./changelog-prs/cache.js";
import { registerChangelogPRsRoute } from "./changelog-prs/handler.js";

const app = express();
app.use(express.json());

// /api/changelog-prs — Node/Express port of the Netlify edge function of the
// same name. Route is registered up front via `app.all` and delegates to the
// real handler once the cache store (Redis primary + file fallback) is ready.
const changelogCachePromise = createCacheStore().catch((err) => {
  console.error("[changelog-prs] failed to initialize cache store:", err);
  return null;
});

app.all("/api/changelog-prs", async (req, res, next) => {
  const cache = await changelogCachePromise;
  if (!cache) {
    return res
      .status(503)
      .set({ "Content-Type": "text/plain; charset=utf-8" })
      .send("changelog-prs service is initializing, retry shortly");
  }
  // Attach the real handler once; subsequent requests skip this wrapper.
  if (!app.__changelogRouteAttached) {
    registerChangelogPRsRoute(app, { cache });
    app.__changelogRouteAttached = true;
  }
  return next();
});

function formatInstallErrorMessage(error) {
  let text = error?.message ?? String(error);
  if (error instanceof CommandError && error.output?.trim()) {
    const tail = error.output.trimEnd().slice(-3500);
    text += `\n\n\`\`\`${tail}\`\`\``;
  }
  return text;
}

function codesandboxUnavailableJsonBody() {
  return {
    error:
      "CodeSandbox is temporarily unavailable. Check the CodeSandbox status page for incidents or maintenance.",
    codesandboxStatusUrl: CODESANDBOX_STATUS_URL,
  };
}

function reportErrorToSlack(error, context) {
  if (!shouldNotifySlack(error)) {
    return;
  }
  const slackWebhook = process.env.SLACK_WEBHOOK;
  if (slackWebhook) {
    fetch(slackWebhook, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        type: "mrkdwn",
        text: `Codesandbox Error: ${formatInstallErrorMessage(error)}: Debug: ${JSON.stringify(context)}`,
      }),
    });
  }
}

/**
 * Install tasks from the template (deduped by command string).
 * Default: start installs in the sandbox and disconnect without waiting — avoids long
 * HTTP requests and matches how installs continue on the VM after the SDK session ends.
 * Set CODESANDBOX_AWAIT_INSTALL=true to wait (and fail the request on npm exit ≠ 0).
 */
async function runCodesandboxInstallTasks(client, tasks) {
  const installTasks = tasks.filter(
    (task) =>
      task.name.toLowerCase().includes("install") &&
      !task.command.includes("postinstall"),
  );
  const seenCommands = new Set();
  const uniqueCommands = [];
  for (const task of installTasks) {
    if (seenCommands.has(task.command)) continue;
    seenCommands.add(task.command);
    uniqueCommands.push(task.command);
  }

  const awaitInstall =
    process.env.CODESANDBOX_AWAIT_INSTALL === "1" ||
    process.env.CODESANDBOX_AWAIT_INSTALL === "true";

  if (!awaitInstall) {
    for (const command of uniqueCommands) {
      await client.commands.runBackground(command);
    }
    await client.disconnect();
    return;
  }

  const maxAttempts = Math.max(
    1,
    Number.parseInt(process.env.CODESANDBOX_INSTALL_RETRY_ATTEMPTS ?? "2", 10) || 2,
  );
  const retryMs = Math.max(
    0,
    Number.parseInt(process.env.CODESANDBOX_INSTALL_RETRY_MS ?? "5000", 10) || 5000,
  );

  for (const command of uniqueCommands) {
    let lastError;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await client.commands.run(command);
        lastError = undefined;
        break;
      } catch (error) {
        lastError = error;
        const retryable =
          error instanceof CommandError &&
          attempt < maxAttempts &&
          (error.exitCode === 1 || error.exitCode === undefined);
        if (retryable) {
          await new Promise((r) => setTimeout(r, retryMs));
          continue;
        }
        throw error;
      }
    }
    if (lastError) throw lastError;
  }

  await client.disconnect();
}

/** GitHub / API “not found” — treat like validation: 400, no Slack (e.g. missing example path or ref). */
function isNotFoundClientError(error) {
  const status = error?.status ?? error?.response?.status;
  return status === 404;
}

app.get("/codesandbox-vm", async (req, res) => {
  const query = {
    exampleDir: req.query["example-dir"],
    exampleBranch: req.query["example-branch"],
    handsontableVersion: req.query["handsontable-version"],
    handsontableBranch: req.query["handsontable-branch"],
    handsontableSha: req.query["handsontable-sha"],
  };

  const paramsCheck = validateQueryParamsSync(query);
  if (!paramsCheck.ok) {
    return res.status(400).json({ error: paramsCheck.message });
  }

  const versionCheck = validateHandsontableVersionParam(query.handsontableVersion);
  if (!versionCheck.ok) {
    return res.status(400).json({ error: versionCheck.message });
  }

  const {
    exampleDir,
    exampleBranch,
    handsontableBranch,
    handsontableSha,
  } = paramsCheck.normalized;
  const handsontableVersion = versionCheck.normalized;
  const handsontablePkgPrNew = versionCheck.pkgPrNew;

  const octokit = new Octokit({
    auth: process.env.GITHUB_TOKEN,
  });

  let exampleExists;
  try {
    exampleExists = await validateExampleDirExistsInRepo(
      octokit,
      exampleDir,
      exampleBranch,
    );
  } catch (error) {
    reportErrorToSlack(error, {
      exampleDir,
      exampleBranch,
      handsontableVersion,
      handsontableBranch,
      handsontableSha,
    });
    return res.status(500).json({ error: formatInstallErrorMessage(error) });
  }
  if (!exampleExists.ok) {
    return res.status(400).json({ error: exampleExists.message });
  }

  let tags = Object.entries({
    exampleDir,
    exampleBranch,
    handsontableVersion,
    handsontableBranch,
    handsontableSha,
  })
    .filter(([_key, value]) => value !== null && value !== undefined)
    .map(([key, value]) => `${key}:${value}`.toLowerCase());
  tags.push("sdk");

  try {
    const sdk = new CodeSandbox();

    let sandboxesByTag = await sdk.sandboxes.list({
      pageSize: 199,
      tags,
    });

    const existingFirstLookup = sandboxesByTag.sandboxes[0];
    if (existingFirstLookup) {
      return res.redirect(
        302,
        `https://codesandbox.io/p/sandbox/${existingFirstLookup.id}?file=&preview=true`,
      );
    }

    const version = await getVersion(
      octokit,
      handsontableBranch,
      handsontableVersion,
      handsontableSha,
    );

    //const templateId = packageJson.config?.codesandbox?.templateId;

    tags = tags.map((tag) => {
      if (tag.includes("handsontableversion")) {
        return `handsontableversion:${version}`;
      }
      return tag;
    });

    sandboxesByTag = await sdk.sandboxes.list({ pageSize: 199, tags });

    const existing = sandboxesByTag.sandboxes[0];
    if (existing) {
      return res.redirect(
        302,
        `https://codesandbox.io/p/sandbox/${existing.id}?file=&preview=true`,
      );
    }

    const files = await fetchFiles(
      octokit,
      "handsontable",
      "examples",
      `examples/${exampleDir}`,
      exampleBranch ? { ref: exampleBranch } : undefined,
    );

    const packageJson = JSON.parse(
      files.find((file) => file?.path?.endsWith("package.json"))?.text || "{}",
    );
    packageJson.dependencies = Object.fromEntries(
      Object.entries(packageJson.dependencies).map(([key, value]) => {
        if (
          key.toString().includes("handsontable") &&
          key.toString() !== "@handsontable/pikaday"
        ) {
          const depVersion = handsontablePkgPrNew
            ? pkgPrNewDependencyUrl(key, version)
            : version;
          return [key, depVersion];
        }
        return [key, value];
      }),
    );

    const templateId = packageJson.config?.codesandbox?.templateId;

    if (!templateId) {
      return res.status(400).json({
        error:
          "This example cannot be opened via /codesandbox-vm: add package.json config.codesandbox.templateId (CodeSandbox template id) for dynamic sandbox creation.",
      });
    }

    const filesToUpload = Object.fromEntries(
      files.filter((file) => {
        if (file.path.includes("package.json")) return false;
        //if (file.path.includes("package-lock.json")) return false;
        if (file.path.endsWith(".ico")) return false;
        return true;
      }).map((file) => {
        let fileName = file.path.substr(`examples/${exampleDir}`.length);
        fileName = fileName.startsWith("/") ? fileName.substr(1) : fileName;
        return [`${fileName}`, { content: file.text }];
      }),
    );

    // Create a sandbox from your custom template
    let sandbox = await sdk.sandboxes.create({
      title: `Handsontable Example ${exampleDir} ${version}`,
      public: true,
      tags: tags,
      id: templateId,
      privacy: "public",
    });

    const client = await sandbox.connect();

    await client.fs.writeTextFile(
      "package.json",
      JSON.stringify(packageJson, null, 2),
    );

    await Promise.all(
      Object.entries(filesToUpload).map(([key, value]) => {
        return client.fs.writeTextFile(key, value.content);
      }),
    );

    const tasks = await client.tasks.getAll();
    await runCodesandboxInstallTasks(client, tasks);

    return res.redirect(
      302,
      `https://codesandbox.io/p/sandbox/${sandbox.id}?file=&preview=true`,
    );
  } catch (error) {
    if (isNotFoundClientError(error)) {
      console.log(error);
      return res.status(400).json({
        error:
          "GitHub resource not found (check example-dir, example-branch, or that the path exists in handsontable/examples)",
      });
    }
    if (isCodesandboxUnavailableError(error)) {
      return res.status(503).json(codesandboxUnavailableJsonBody());
    }
    reportErrorToSlack(error, {
      exampleDir,
      exampleBranch,
      handsontableVersion,
      handsontableBranch,
      handsontableSha,
    });
    return res.status(500).json({ error: formatInstallErrorMessage(error) });
  }
});

app.get("/codesandbox-browser", async (req, res) => {
  const query = {
    exampleDir: req.query["example-dir"],
    exampleBranch: req.query["example-branch"],
    handsontableVersion: req.query["handsontable-version"],
    handsontableBranch: req.query["handsontable-branch"],
    handsontableSha: req.query["handsontable-sha"],
  };

  const paramsCheckBrowser = validateQueryParamsSync(query);
  if (!paramsCheckBrowser.ok) {
    return res.status(400).json({ error: paramsCheckBrowser.message });
  }

  const versionCheckBrowser = validateHandsontableVersionParam(
    query.handsontableVersion,
  );
  if (!versionCheckBrowser.ok) {
    return res.status(400).json({ error: versionCheckBrowser.message });
  }

  const {
    exampleDir,
    exampleBranch,
    handsontableBranch,
    handsontableSha,
  } = paramsCheckBrowser.normalized;
  const handsontableVersion = versionCheckBrowser.normalized;
  const handsontablePkgPrNewBrowser = versionCheckBrowser.pkgPrNew;

  const octokitBrowser = new Octokit({
    auth: process.env.GITHUB_TOKEN,
  });

  let exampleExistsBrowser;
  try {
    exampleExistsBrowser = await validateExampleDirExistsInRepo(
      octokitBrowser,
      exampleDir,
      exampleBranch,
    );
  } catch (error) {
    reportErrorToSlack(error, {
      exampleDir,
      exampleBranch,
      handsontableVersion,
      handsontableBranch,
      handsontableSha,
    });
    return res.status(500).json({ error: formatInstallErrorMessage(error) });
  }
  if (!exampleExistsBrowser.ok) {
    return res.status(400).json({ error: exampleExistsBrowser.message });
  }

  try {
    const version = await getVersion(
      octokitBrowser,
      handsontableBranch,
      handsontableVersion,
      handsontableSha,
    );

    const files = await fetchFiles(
      octokitBrowser,
      "handsontable",
      "examples",
      `examples/${exampleDir}`,
      exampleBranch ? { ref: exampleBranch } : undefined,
    );

    const packageJson = JSON.parse(
      files.find((file) => file?.path?.endsWith("package.json"))?.text || "{}",
    );

    packageJson.dependencies = Object.fromEntries(
      Object.entries(packageJson.dependencies).map(([key, value]) => {
        if (
          key.toString().includes("handsontable") &&
          key.toString() !== "@handsontable/pikaday"
        ) {
          const depVersion = handsontablePkgPrNewBrowser
            ? pkgPrNewDependencyUrl(key, version)
            : version;
          return [key, depVersion];
        }
        return [key, value];
      }),
    );

    let defineResponse = await fetch(
      "https://codesandbox.io/api/v1/sandboxes/define?json=1",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          files: {
            "package.json": {
              content: packageJson,
            },
            ...Object.fromEntries(
              files.filter((file) => {
                if (file.path.includes("package.json")) return false;
                if (file.path.includes("package-lock.json")) return false;
                if (file.path.endsWith(".ico")) return false;
                return true;
              }).map((file) => {
                let fileName = file.path.substr(
                  `examples/${exampleDir}`.length,
                );
                fileName = fileName.startsWith("/")
                  ? fileName.substr(1)
                  : fileName;
                return [`${fileName}`, { content: file.text }];
              }),
            ),
          },
        }),
      },
    );


    let defineJson = await defineResponse.json();

    return res.redirect(
      `https://codesandbox.io/embed/${defineJson.sandbox_id}?view=preview&hidenavigation=1`,
    );
    
  } catch (error) {
    if (isNotFoundClientError(error)) {
      console.log(error);
      return res.status(400).json({
        error:
          "GitHub resource not found (check example-dir, example-branch, or that the path exists in handsontable/examples)",
      });
    }
    if (isCodesandboxUnavailableError(error)) {
      return res.status(503).json(codesandboxUnavailableJsonBody());
    }
    console.log(error);
    reportErrorToSlack(error, {
      exampleDir,
      exampleBranch,
      handsontableVersion,
      handsontableBranch,
      handsontableSha,
    });
    return res.status(500).json({ error: formatInstallErrorMessage(error) });
  }
});

app.listen(process.env.PORT || 3000);
