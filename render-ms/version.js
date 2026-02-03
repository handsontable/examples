import { Octokit } from "octokit";

export const getVersion = async (octokit, handsontableBranch, handsontableVersion, handsontableSha) => {


    let version = 'latest';

    if (handsontableVersion) {
      version = handsontableVersion;
    } else if (handsontableBranch) {
      const [{ data: branchData }, npmRawData]  = await Promise.all([octokit.rest.repos.getBranch({
        owner: 'handsontable',
        repo: 'handsontable',
        branch: handsontableBranch,
      }), fetch('https://registry.npmjs.org/handsontable')]);
      const npmData = await npmRawData.json();
      version  = Object.keys(npmData.versions).find(version => version.includes(branchData.commit.sha.substring(0, 7))) || version;
    } else if (handsontableSha) {
      const npmRawData  = await fetch('https://registry.npmjs.org/handsontable');
      const npmData = await npmRawData.json();
      version  = Object.keys(npmData.versions).find(version => version.includes(handsontableSha.substring(0, 7))) || version;
    }

    if (version === 'latest') {
      const npmRawData  = await fetch('https://registry.npmjs.org/handsontable/latest');
      const npmData = await npmRawData.json();
      return npmData.version;
      // https://registry.npmjs.org/handsontable/latest
    }

    return version;
}