# Contributing

Thanks for helping improve Glassnote. Small, focused changes are easiest to review.

- Search existing issues before reporting a bug or requesting a feature.
- Include your Windows version, app version, display scaling, exact steps, and
  expected versus actual behavior. Use synthetic screenshots and remove private text.
- For a larger change, discuss the problem in an issue before building it.
- Follow the compact interface, local processing, one-level folders, and ordinary
  file storage. Avoid new dependencies and abstractions unless the change needs them.
- Validate untrusted IDs, filenames, geometry, and destinations in Rust. Keep error
  messages actionable and preserve user data if a write fails.

[Build and checks](docs/build.md) explains the development setup. Run checks for
the code paths you change; include screenshots for visual changes and describe
any native hardware tests in your pull request. Browser IPC mocks alone cannot
verify a microphone or Windows screen capture.

Never commit captures, recordings, speech models, `.verification/`, `.tools/`,
credentials, or personal data. Do not run destructive tests against a real library.

Contributions are licensed under the project's MIT license. Please be respectful,
assume good intent, and keep discussion focused on the work. Harassment and sharing
someone else's private information are not welcome.
