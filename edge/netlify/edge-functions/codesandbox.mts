import type { Context } from "https://edge.netlify.com";
import { Octokit } from 'https://esm.sh/@octokit/rest';
import { fetchFiles } from '../../src/github.ts';
import { wrapHtml, objectToForm } from '../../src/index.ts';
import { getVersion } from '../../src/version.ts';

export default async (request: Request, _context: Context) => {

  // Handle CORS
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  const url = new URL(request.url);

  const octokit = new Octokit({
    auth: Deno.env.get('GITHUB_TOKEN') || Netlify.env.get("GITHUB_TOKEN")
  });

  const { exampleDir, exampleBranch, handsontableVersion, handsontableBranch, handsontableSha } = {
    exampleDir: url.searchParams.get('example-dir'),
    exampleBranch: url.searchParams.get('example-branch'),
    handsontableVersion: url.searchParams.get('handsontable-version'),
    handsontableBranch: url.searchParams.get('handsontable-branch'),
    handsontableSha: url.searchParams.get('handsontable-sha'),
  }

  try {
    const version = await getVersion(octokit, handsontableBranch, handsontableVersion, handsontableSha);
    const files = await fetchFiles(octokit, 'handsontable', 'examples', `examples/${exampleDir}`, exampleBranch ? { ref: exampleBranch } : undefined);
    const packageJson = JSON.parse(files.find(file => file?.path?.endsWith('package.json'))?.text || '{}');
    //packageJson.dependencies.handsontable = version;
    packageJson.dependencies = Object.fromEntries(Object.entries(packageJson.dependencies).map(([key, value]) => {
      if ((key.toString().includes('@handsontable/') || key.toString() === ('handsontable')) && key.toString() !== ('@handsontable/pikaday')) {
        return [key, version];
      }
      return [key, value];
    }));

    let f = await fetch("https://codesandbox.io/api/v1/sandboxes/define?json=1", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json"
      },
      body: JSON.stringify({
        files: {
          "package.json": {
            content: packageJson
          },
          ...Object.fromEntries(
            files.filter(file => {
              if (file.path.includes('package.json')) return false;
              if (file.path.includes('package-lock.json')) return false;
              if (file.path.endsWith('.ico')) return false;
              return true;
            }).map(file => {
              let fileName = file.path.substr(`examples/${exampleDir}`.length)
              fileName = fileName.startsWith('/') ? fileName.substr(1) : fileName;
              return [`${fileName}`, { content: file.text }]
            })),
        }
      })
    })
    
    let j = await f.json();
    
    return Response.redirect(`https://codesandbox.io/embed/${j.sandbox_id}?view=preview&hidenavigation=1`)

  } catch (error) {
    
    const  slackWebhook  = Deno.env.get('SLACK_WEBHOOK') || Netlify.env.get("SLACK_WEBHOOK")
    if (slackWebhook) {
      fetch(slackWebhook, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ "type": "mrkdwn", "text": `Examples Stackblizt Error: ${error.message}: Debug: ${JSON.stringify({ exampleDir, exampleBranch, handsontableVersion, handsontableBranch, handsontableSha })}` })
      });
    }

    console.log(error);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: {
        'Content-Type': 'application/json',
        ...corsHeaders
      }
    });
  }
};
