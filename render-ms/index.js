// index.js
import express from "express";
import { CodeSandbox } from "@codesandbox/sdk";
import { Octokit } from "octokit";
import { fetchFiles } from "./github.js";
import { getVersion } from "./version.js";
import { validateHandsontableVersionParam } from "./validate-handsontable-version.js";
import {
  validateQueryParamsSync,
  validateExampleDirExistsInRepo,
} from "./validate-query-params.js";

const app = express();
app.use(express.json());

function reportErrorToSlack(error, context) {
  const slackWebhook = process.env.SLACK_WEBHOOK;
  if (slackWebhook) {
    fetch(slackWebhook, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        type: "mrkdwn",
        text: `Codesandbox Error: ${error.message}: Debug: ${JSON.stringify(context)}`,
      }),
    });
  }
  
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
    return res.status(500).json({ error: error.message });
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
        `https://codesandbox.io/p/sandbox/${existingFirstLookup.id}?file=&preview=true`,
        302,
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
        `https://codesandbox.io/p/sandbox/${existing.id}?file=&preview=true`,
        302,
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
        ) return [key, version];
        return [key, value];
      }),
    );

    const templateId = packageJson.config?.codesandbox?.templateId;

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

    if (templateId) {
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

      for (const task of tasks) {
        if (task.name.toLowerCase().includes("install") && !task.command.includes("postinstall")) {
          await client.commands.run(task.command);
        }
      }

      return res.redirect(
        `https://codesandbox.io/p/sandbox/${sandbox.id}?file=&preview=true`,
        302,
      );
    }
  } catch (error) {
    if (isNotFoundClientError(error)) {
      console.log(error);
      return res.status(400).json({
        error:
          "GitHub resource not found (check example-dir, example-branch, or that the path exists in handsontable/examples)",
      });
    }
    reportErrorToSlack(error, {
      exampleDir,
      exampleBranch,
      handsontableVersion,
      handsontableBranch,
      handsontableSha,
    });
    return res.status(500).json({ error: error.message });
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
    return res.status(500).json({ error: error.message });
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
          return [key, version];
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
    console.log(error);
    reportErrorToSlack(error, {
      exampleDir,
      exampleBranch,
      handsontableVersion,
      handsontableBranch,
      handsontableSha,
    });
    return res.status(500).json({ error: error.message });
  }
});

app.listen(process.env.PORT || 3000);
