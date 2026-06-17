
## Local Setup

Git clone:

```bash
gh clone https://github.com/sarath/gemmanotes
```

Development:
```bash
npm install
npm run build      # production bundle -> main.js
npm run dev        # watch mode
```

Install into a vault for local testing:

Mac
```bash
git clone https://github.com/sarath/gemmanotes
./install.sh /path/to/your/vault <feature-branch>
```

This fetches `origin`, checks out `origin/<feature-branch>` cleanly, runs
`npm run build`, and copies `main.js`, `manifest.json`, and `styles.css`
into `<vault>/.obsidian/plugins/gemmanotes/`. Then enable the plugin and use
**Settings → GemmaNotes → Download** to fetch the model (~3.2 GB for E2B,
~5 GB for E4B).

## Local Testing and Development

If you are developing inside Google Cloud Shell and want to deploy, test, and debug the plugin directly in a local Obsidian instance:

### 1. Tunnel Remote Debugging Port
Start your local Obsidian instance with remote debugging enabled (e.g., `obsidian --remote-debugging-port=9222`). Then, run the following command to tunnel port `9222` from your local machine to your Cloud Shell workspace:
```bash
gcloud cloud-shell ssh --ssh-flag="-L 9222:localhost:9222"
```
This allows scripts running in the Cloud Shell environment to connect to the Chrome DevTools protocol on your local Obsidian instance.

### 2. Build, Deploy, and Test
1. Compile the production bundle:
   ```bash
   npm run build
   ```
2. Deploy the files (`main.js`, `manifest.json`, `styles.css`) to the connected Obsidian instance and automatically reload the plugin:
   ```bash
   npm run local:deploy
   ```
3. Test model loading and verify initialization:
   ```bash
   npm run local:test-load
   ```
