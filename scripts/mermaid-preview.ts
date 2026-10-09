import { Glob } from "bun";
import { log } from "./lib/log.ts";

const root = process.cwd();

const listPreviewFiles = (): string[] => {
  const glob = new Glob("docs/**/*.{mmd,html}");
  const scanned = glob.scanSync({ cwd: root });
  const files = Array.from(scanned);
  return files.sort();
};

const serveFile = async (path: string): Promise<Response> => {
  if (!listPreviewFiles().includes(path)) {
    return new Response("not found", { status: 404 });
  }
  const file = Bun.file(`${root}/${path}`);
  if (!(await file.exists())) {
    return new Response("not found", { status: 404 });
  }
  return new Response(file);
};

const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Documentation Preview</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { background: #1e1e2e; color: #cdd6f4; font-family: monospace; }
    nav {
      padding: 12px 20px;
      background: #181825;
      border-bottom: 1px solid #313244;
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 16px;
      font-size: 14px;
    }
    nav a {
      color: #89b4fa;
      text-decoration: none;
      padding: 4px 8px;
      border-radius: 4px;
    }
    nav a:hover, nav a.active {
      background: #313244;
    }
    nav a.active { color: #a6e3a1; }
    .status {
      margin-left: auto;
      color: #6c7086;
      font-size: 12px;
    }
    .mermaid-preview__canvas {
      display: flex;
      justify-content: flex-start;
      padding: 40px 20px;
      overflow: auto;
    }
    .mermaid-preview__canvas--html { padding: 0; }
    .mermaid-preview__diagram { max-width: none; height: auto; flex-shrink: 0; }
    .mermaid-preview__page { width: 100%; height: calc(100vh - 80px); min-height: 600px; border: 0; }
  </style>
</head>
<body>
  <nav id="nav"></nav>
  <div id="diagram" class="mermaid-preview__canvas">select a page</div>

  <script type="module">
    let mermaid = null;

    const loadMermaid = async () => {
      if (mermaid !== null) return mermaid;
      const module = await import('https://cdn.jsdelivr.net/npm/mermaid@11.12.0/dist/mermaid.esm.min.mjs');
      mermaid = module.default;
      mermaid.initialize({
        startOnLoad: false,
        theme: 'dark',
        themeVariables: { edgeLabelBackground: 'transparent' },
        flowchart: { useMaxWidth: false, htmlLabels: true },
        sequence: { useMaxWidth: false }
      });
      return mermaid;
    };

    let current = null;
    let lastContent = '';
    let renderCounter = 0;

    const loadFileList = async () => {
      const res = await fetch('/api/files');
      if (!res.ok) throw new Error('page list request failed: ' + res.status);
      const files = await res.json();
      const nav = document.getElementById('nav');
      nav.innerHTML = files
        .map(f => '<a href="#" data-file="' + f + '">' + f.replace('docs/', '') + '</a>')
        .join('')
        + '<span class="status" id="status"></span>';
      nav.querySelectorAll('a').forEach(a => {
        a.addEventListener('click', (e) => {
          e.preventDefault();
          select(a.dataset.file);
        });
      });
    };

    const select = (file) => {
      current = file;
      lastContent = '';
      document.querySelectorAll('nav a').forEach(a => {
        a.classList.toggle('active', a.dataset.file === file);
      });
      poll();
    };

    const render = async (source) => {
      renderCounter++;
      const id = 'mmd-' + renderCounter;
      const renderer = await loadMermaid();
      const { svg } = await renderer.render(id, source);
      document.getElementById('diagram').innerHTML = svg;
      document.querySelector('#diagram svg').classList.add('mermaid-preview__diagram');
    };

    const renderPage = async (source) => {
      const canvas = document.getElementById('diagram');
      const isHtml = current.endsWith('.html');
      canvas.classList.toggle('mermaid-preview__canvas--html', isHtml);
      if (!isHtml) {
        await render(source);
        return;
      }
      const frame = document.createElement('iframe');
      frame.className = 'mermaid-preview__page';
      frame.title = current;
      frame.setAttribute('sandbox', '');
      frame.srcdoc = source;
      canvas.replaceChildren(frame);
    };

    const reportError = (error) => {
      document.getElementById('diagram').textContent = String(error);
    };

    const poll = async () => {
      if (!current) return;
      try {
        const res = await fetch('/file/' + current + '?t=' + Date.now());
        if (!res.ok) throw new Error('preview request failed: ' + res.status);
        const content = await res.text();
        if (content !== lastContent) {
          await renderPage(content);
          lastContent = content;
          const status = document.getElementById('status');
          if (status) status.textContent = 'updated ' + new Date().toLocaleTimeString();
        }
      } catch (error) {
        reportError(error);
      }
    };

    try {
      await loadFileList();
      const params = new URLSearchParams(window.location.search);
      const initial = params.get('file');
      if (initial) select(initial);
      setInterval(poll, 1000);
    } catch (error) {
      reportError(error);
    }
  </script>
</body>
</html>`;

const server = Bun.serve({
  hostname: "0.0.0.0",
  port: 0,
  fetch: async (req) => {
    try {
      const url = new URL(req.url);

      if (url.pathname === "/" || url.pathname === "/index.html") {
        return new Response(html, {
          headers: { "content-type": "text/html" },
        });
      }

      if (url.pathname === "/api/files") {
        const files = listPreviewFiles();
        return Response.json(files);
      }

      if (url.pathname.startsWith("/file/")) {
        const path = url.pathname.slice(6);
        return await serveFile(path);
      }

      return new Response("not found", { status: 404 });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.error(`mermaid preview: ${message}`);
      return new Response("preview request failed", { status: 500 });
    }
  },
});

log.ok(`mermaid preview: http://127.0.0.1:${server.port}`);
