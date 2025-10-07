import { Buffer } from "node:buffer";
import { Octokit } from 'https://esm.sh/@octokit/rest';

// TODO: 
// this is good for private repo 
// public repo should fetch files from URL withouth using octokit and consuming tokens

export const fetchFiles = async (octokit:Octokit, owner:string, repo:string, directory:string, options:Record<string, string> = {}) => {
  var tree = await recurseTree(octokit, owner, repo, directory, options);

  var files = tree
    .filter((node) => node.path.startsWith(directory) && node.type === 'file')
    .map(async (node) => {
      var { data } = await octokit.git.getBlob({
        owner,
        repo,
        file_sha: node.sha,
        ...options
      });
      return {
        path: node.path,
        contents: data.size ? Buffer.from(data.content, data.encoding) : null,
        text: data.size ? Buffer.from(data.content, data.encoding).toString('utf-8') : ''
      };
    });

  return Promise.all(files);
}

const recurseTree = async (octokit, owner, repo, directory, options:Record<string, string> = {}) => {
  const { data } = await octokit.repos.getContent({
    owner,
    repo,
    path: directory,
    ...options
    });
 


  const recurseDirs = data.map((node) => {
    if (node.type === 'dir') {
      return recurseTree(octokit, owner, repo, node.path, options);
    }
    return {
      path: node.path,
      type: node.type,
      sha: node.sha,
    };
  });

  return Promise.all(recurseDirs).then((nodes) => nodes.flat());
}
