const http = require('http');
const fs = require('fs');
const path = require('path');

const mainJs = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
const manifestJson = fs.readFileSync(path.join(__dirname, '../manifest.json'), 'utf8');
const stylesCss = fs.readFileSync(path.join(__dirname, '../styles.css'), 'utf8');

http.get('http://localhost:9222/json', (res) => {
  let data = '';
  res.on('data', (chunk) => { data += chunk; });
  res.on('end', () => {
    try {
      const list = JSON.parse(data);
      const target = list.find(t => t.url.includes('obsidian.md') && t.type === 'page');
      if (target) {
        console.log("Connecting to:", target.webSocketDebuggerUrl);
        const wsUrl = target.webSocketDebuggerUrl;
        const ws = new WebSocket(wsUrl);
        
        let msgId = 1;
        function send(method, params = {}) {
          const id = msgId++;
          ws.send(JSON.stringify({ id, method, params }));
          return id;
        }

        ws.onopen = () => {
          console.log("Connected! Writing files...");
          
          // Enable Console & Runtime
          send("Console.enable");
          send("Runtime.enable");

          // Write files
          const writeExpression = `
            (async function() {
              const adapter = app.vault.adapter;
              const dir = app.plugins.manifests.gemmanotes.dir;
              await adapter.write(dir + "/manifest.json", ${JSON.stringify(manifestJson)});
              await adapter.write(dir + "/styles.css", ${JSON.stringify(stylesCss)});
              await adapter.write(dir + "/main.js", ${JSON.stringify(mainJs)});
              return "Files written successfully!";
            })()
          `;
          send("Runtime.evaluate", {
            expression: writeExpression,
            awaitPromise: true
          });
        };

        ws.onmessage = (event) => {
          const resData = JSON.parse(event.data);
          
          // Log console messages from Obsidian
          if (resData.method === "Console.messageAdded") {
            const msg = resData.params.message;
            console.log(`[Obsidian Console] [${msg.level}] ${msg.text}`);
          }

          // Handle the response of our evaluations
          if (resData.id === 3) { // This corresponds to the write command
            console.log("Write response:", resData.result?.result?.value);
            
            // Now trigger reload
            console.log("Reloading gemmanotes plugin...");
            send("Runtime.evaluate", {
              expression: 'app.plugins.disablePlugin("gemmanotes").then(() => app.plugins.enablePlugin("gemmanotes")).then(() => "Reload completed!")',
              awaitPromise: true
            });
          } else if (resData.id === 4) { // This corresponds to the reload command
            console.log("Reload response:", resData.result?.result?.value);
            console.log("Waiting for console outputs...");
          }
        };

        ws.onerror = (err) => {
          console.error("WS Error:", err);
        };

        // Exit after 8 seconds to allow reload logs to stream in
        setTimeout(() => {
          console.log("Done. Closing connection.");
          ws.close();
          process.exit(0);
        }, 8000);
      } else {
        console.error("Obsidian page not found in DevTools targets.");
      }
    } catch(e) {
      console.error(e);
    }
  });
}).on('error', (err) => {
  console.error("HTTP Error:", err);
});
