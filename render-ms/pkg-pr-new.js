/**
 * pkg.pr.new preview installs, e.g. npm i https://pkg.pr.new/handsontable@12312
 * @param {string} packageName - npm package name (e.g. handsontable, @handsontable/react-wrapper)
 * @param {string} buildRef - PR / build id from the preview URL
 * @returns {string}
 */
export function pkgPrNewDependencyUrl(packageName, buildRef) {
  return `https://pkg.pr.new/${packageName}@${buildRef}`;
}

/**
 * @param {string} value - normalized build ref (digits) or full pkg.pr.new URL
 * @returns {string | null} build ref, or null if not a pkg.pr.new input
 */
export function parsePkgPrNewBuildRef(value) {
  const trimmed = String(value).trim();
  if (/^\d+$/.test(trimmed)) {
    return trimmed;
  }
  try {
    const u = new URL(trimmed);
    if (u.protocol !== "https:" || u.hostname !== "pkg.pr.new") {
      return null;
    }
    const path = u.pathname.replace(/^\//, "");
    const at = path.lastIndexOf("@");
    if (at <= 0) {
      return null;
    }
    const ref = path.slice(at + 1);
    if (ref === "") {
      return null;
    }
    return ref;
  } catch {
    return null;
  }
}
