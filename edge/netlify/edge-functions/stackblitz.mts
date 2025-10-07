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
    const files = await fetchFiles(octokit, 'handsontable', 'examples-poc', `examples/${exampleDir}`, exampleBranch ? { ref: exampleBranch } : undefined);
    const packageJson = JSON.parse(files.find(file => file?.path?.endsWith('package.json'))?.text || '{}');
    //packageJson.dependencies.handsontable = version;
    packageJson.dependencies = Object.fromEntries(Object.entries(packageJson.dependencies).map(([key, value]) => {
      if ((key.toString().includes('@handsontable/') || key.toString() === ('handsontable')) && key.toString() !== ('@handsontable/pikaday')) {
        return [key, version];
      }
      return [key, value];
    }));

    console.log(packageJson.dependencies);

    let stackblitzTemplate = packageJson.config?.stackblitz?.template || 'node';

    const formObject = {
      'project[template]': stackblitzTemplate,
      'project[description]': `Handsontable Example ${exampleDir}`,
      'project[dependencies]': JSON.stringify(packageJson.dependencies, null, 2),
      ...Object.fromEntries(
        files.filter(file => {
          if (file.path.includes('package.json')) return false;
          if (file.path.includes('package-lock.json')) return false;
          return true;
        }).map(file => {
          let fileName = file.path.substr(`examples/${exampleDir}`.length)
          fileName = fileName.startsWith('/') ? fileName.substr(1) : fileName;
          return [`project[files][${fileName}]`, file.text]
        })),
    }

    if (stackblitzTemplate !== 'typescript' || stackblitzTemplate === 'javascript') {
      formObject['project[files][package.json]'] = JSON.stringify(packageJson, null, 2);
    }

    if (stackblitzTemplate === 'typescript') {
      delete formObject['project[files][tsconfig.json]'];
    }

    const html = wrapHtml(objectToForm(formObject))

    return new Response(html, {
      headers: {
        'Content-Type': 'text/html',
        ...corsHeaders
      }
    });

  } catch (error) {
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
