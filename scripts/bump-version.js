const fs = require("fs");
const path = require("path");

function main() {
  const args = process.argv.slice(2);
  const bumpType = args[0];
  const prNumber = args[1];

  if (!bumpType) {
    console.error("Usage: node bump-version.js <major|minor|patch|pr> [<pr_number>]");
    process.exit(1);
  }

  if (bumpType === "pr" && !prNumber) {
    console.error("Error: pr_number is required when bump_type is 'pr'");
    process.exit(1);
  }

  const manifestPath = path.join(__dirname, "..", "manifest.json");
  const packagePath = path.join(__dirname, "..", "package.json");
  const versionsPath = path.join(__dirname, "..", "versions.json");

  // 1. Read manifest.json
  if (!fs.existsSync(manifestPath)) {
    console.error(`Error: manifest.json not found at ${manifestPath}`);
    process.exit(1);
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const currentVersion = manifest.version;
  const minAppVersion = manifest.minAppVersion || "1.5.0";

  // 2. Parse current version
  // Match semantic version format, ignoring any existing pre-release suffixes
  const match = currentVersion.match(/^(\d+)\.(\d+)\.(\d+)(?:-.*)?$/);
  if (!match) {
    console.error(`Error: Invalid semantic version in manifest.json: ${currentVersion}`);
    process.exit(1);
  }

  let major = parseInt(match[1], 10);
  let minor = parseInt(match[2], 10);
  let patch = parseInt(match[3], 10);

  // 3. Calculate next version
  let nextVersion = "";
  if (bumpType === "major") {
    major++;
    minor = 0;
    patch = 0;
    nextVersion = `${major}.${minor}.${patch}`;
  } else if (bumpType === "minor") {
    minor++;
    patch = 0;
    nextVersion = `${major}.${minor}.${patch}`;
  } else if (bumpType === "patch") {
    patch++;
    nextVersion = `${major}.${minor}.${patch}`;
  } else if (bumpType === "pr") {
    nextVersion = `${major}.${minor}.${patch}-pr.${prNumber}`;
  } else {
    console.error(`Error: Invalid bump type '${bumpType}'. Must be major, minor, patch, or pr.`);
    process.exit(1);
  }

  // 4. Update manifest.json
  manifest.version = nextVersion;
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");

  // 5. Update package.json
  if (fs.existsSync(packagePath)) {
    const packageJson = JSON.parse(fs.readFileSync(packagePath, "utf8"));
    packageJson.version = nextVersion;
    fs.writeFileSync(packagePath, JSON.stringify(packageJson, null, 2) + "\n", "utf8");
  }

  // 6. Update versions.json
  if (fs.existsSync(versionsPath)) {
    const versions = JSON.parse(fs.readFileSync(versionsPath, "utf8"));
    versions[nextVersion] = minAppVersion;
    fs.writeFileSync(versionsPath, JSON.stringify(versions, null, 2) + "\n", "utf8");
  } else {
    // Create new versions.json if it doesn't exist
    const versions = { [nextVersion]: minAppVersion };
    fs.writeFileSync(versionsPath, JSON.stringify(versions, null, 2) + "\n", "utf8");
  }

  console.log(nextVersion);
}

main();
