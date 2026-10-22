# Security

Only the latest release receives security fixes. Glassnote is an early desktop
app and stores screenshots, transcripts, and recordings unencrypted in your
Windows user profile. Protect that profile and review exports before sharing.
Screenshots and voice notes may contain credentials or confidential information.

Report vulnerabilities privately through
[GitHub's private vulnerability reporting](https://github.com/YG99999/glassnote/security/advisories/new).
Include the affected version, impact, and minimal reproduction using synthetic
data. Do not put credentials, private recordings, or exploit details in public
issues. There is no guaranteed response time or paid bug bounty.

The app downloads only the speech model during normal use and verifies its
expected size and SHA-256 before publishing it. Tauri permissions, local asset
scopes, and validated Rust commands restrict the interface's access to local files.
Release checksums detect mismatched downloads; they are not a code-signing identity.
