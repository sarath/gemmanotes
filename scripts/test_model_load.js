const http = require('http');

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
          console.log("Connected! Checking status and triggering model load...");
          
          send("Console.enable");
          send("Runtime.enable");

          // Check if already loaded or currently loading from startup.
          const checkAndLoadExpr = `
            (async function() {
              const plugin = app.plugins.plugins.gemmanotes;
              if (!plugin) return "Plugin not found!";
              
              const backend = plugin.backend;
              if (!backend) return "Backend not initialized!";
              
              if (backend.ready) {
                return "Already loaded!";
              }
              
              if (plugin.loadPromise) {
                console.log("Awaiting background startup loading...");
                try {
                  await plugin.loadPromise;
                  return "Load successful!";
                } catch (e) {
                  return "Load failed: " + e.message;
                }
              }
              
              return "Not loaded and not loading!";
            })()
          `;
          
          send("Runtime.evaluate", {
            expression: checkAndLoadExpr,
            awaitPromise: true
          });
        };

        ws.onmessage = (event) => {
          const resData = JSON.parse(event.data);
          
          if (resData.method === "Console.messageAdded") {
            const msg = resData.params.message;
            console.log(`[Obsidian Console] [${msg.level}] ${msg.text}`);
          }

          if (resData.id === 3) {
            console.log("Evaluation completed! Result:", resData.result?.result?.value);
            ws.close();
            process.exit(0);
          }
        };

        ws.onerror = (err) => {
          console.error("WS Error:", err);
        };

        // Allow up to 30 seconds for the model to load
        setTimeout(() => {
          console.log("Timeout reached. Closing.");
          ws.close();
          process.exit(0);
        }, 30000);
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
