// index.js
import express from "express";
import { CodeSandbox } from "@codesandbox/sdk";
import { Octokit } from "octokit";
import { fetchFiles } from "./github.js";
import { getVersion } from "./version.js";

const app = express();
app.use(express.json());

app.get("/codesandbox-vm", async (req, res) => {
  const {
    exampleDir,
    exampleBranch,
    handsontableVersion,
    handsontableBranch,
    handsontableSha,
  } = {
    exampleDir: req.query["example-dir"],
    exampleBranch: req.query["example-branch"],
    handsontableVersion: req.query["handsontable-version"],
    handsontableBranch: req.query["handsontable-branch"],
    handsontableSha: req.query["handsontable-sha"],
  };

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

    const octokit = new Octokit({
      auth: process.env.GITHUB_TOKEN,
    });

    let sandboxesByTag = await sdk.sandboxes.list({
      pageSize: 199,
      tags,
    });

    if (handsontableVersion !== "latest") {
      const existing = sandboxesByTag.sandboxes[0];
      if (existing) {
        return res.redirect(
          `https://codesandbox.io/p/sandbox/${existing.id}?file=&preview=true`,
          302,
        );
      }
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
    const slackWebhook = process.env.SLACK_WEBHOOK;
    if (slackWebhook) {
      fetch(slackWebhook, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          "type": "mrkdwn",
          "text": `Codesandbox Error: ${error.message}: Debug: ${
            JSON.stringify({
              exampleDir,
              exampleBranch,
              handsontableVersion,
              handsontableBranch,
              handsontableSha,
            })
          }`,
        }),
      });
    }

    console.log(error);
    return res.status(500).json({ error: error.message });
  }
});

app.get("/codesandbox-browser", async (req, res) => {
  const {
    exampleDir,
    exampleBranch,
    handsontableVersion,
    handsontableBranch,
    handsontableSha,
  } = {
    exampleDir: req.query["example-dir"],
    exampleBranch: req.query["example-branch"],
    handsontableVersion: req.query["handsontable-version"],
    handsontableBranch: req.query["handsontable-branch"],
    handsontableSha: req.query["handsontable-sha"],
  };

  try {
    const octokit = new Octokit({
      auth: process.env.GITHUB_TOKEN,
    });

    const version = await getVersion(
      octokit,
      handsontableBranch,
      handsontableVersion,
      handsontableSha,
    );

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
          return [key, version];
        }
        return [key, value];
      }),
    );

    // const filesToUpload = Object.fromEntries(
    //   files.filter((file) => {
    //     if (file.path.includes("package.json")) return false;
    //     if (file.path.includes("package-lock.json")) return false;
    //     if (file.path.endsWith(".ico")) return false;
    //     return true;
    //   }).map((file) => {
    //     let fileName = file.path.substr(`examples/${exampleDir}`.length);
    //     fileName = fileName.startsWith("/") ? fileName.substr(1) : fileName;
    //     return [`${fileName}`, { content: file.text }];
    //   }),
    // );

    // Create a sandbox from your custom template this is a browser example

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

    return res.status(200).json(defineJson);

    return Response.redirect(
      `https://codesandbox.io/embed/${defineJson.sandbox_id}?view=preview&hidenavigation=1`,
    );
  } catch (error) {
    const slackWebhook = process.env.SLACK_WEBHOOK;
    if (slackWebhook) {
      fetch(slackWebhook, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          "type": "mrkdwn",
          "text": `Codesandbox Error: ${error.message}: Debug: ${
            JSON.stringify({
              exampleDir,
              exampleBranch,
              handsontableVersion,
              handsontableBranch,
              handsontableSha,
            })
          }`,
        }),
      });
    }

    console.log(error);
    return res.status(500).json({ error: error.message });
  }
});

app.listen(process.env.PORT || 3000);
