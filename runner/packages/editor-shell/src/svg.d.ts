// Vite imports .svg as a URL string.
declare module "*.svg" {
  const url: string;
  export default url;
}
