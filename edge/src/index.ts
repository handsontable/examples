export const wrapHtml = (html: string) => {
    return `<!DOCTYPE html>
  <html lang="en">
    <head>
      <title>Home</title>
    </head>
    <style>
        html, body { height: 100%; width: 100%; margin: 0; padding: 0; }
        body {
            background: linear-gradient(142deg, #052a79, #04349b, #0e50c8);
        }
        form { display: flex; justify-content: center; align-items: center; height: 100%; }
        button { background: #0e50c8; color: white; padding: 10px 20px; border: none; border-radius: 5px; cursor: pointer; }
    </style>
    <body>
      ${html}
    </body>
  </html>`
  }
  
  export const escapeQuotes = (value: string) => {
    return value.replaceAll('"', '&quot;');
  }
  
  export const objectToForm = (obj: Record<string, string>) => {
    const values = Object.entries(obj).map(([key, value]) => {
      return `<input type="hidden" name="${key}" value="${escapeQuotes(value)}" />`;
    }).join('');
  
    return `<form
        id="mainForm"
        method="post"
        action="https://stackblitz.com/run?embed=1&view=preview&hideExplorer=0&hideNavigation=1"
        target="_self"
      >${values}
      <button type="submit">Redirecting to Stackblitz...</button></form><script>document.querySelector('form').submit();</script>`
  }