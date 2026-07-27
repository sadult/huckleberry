# Contributing to Huckleberry

Thanks for taking the time to help. Huckleberry is a small, dependency-free
browser extension, so contributing is intentionally low-ceremony.

## Ground rules

- **English only.** Every string, comment, commit message and document is written in English.
- **No build step, no dependencies.** Plain ES modules-free JavaScript, plain CSS, no bundler, no npm packages shipped in the extension.
- **No new remote assets.** Fonts, icons and styles must ship inside the extension.
- **Keep it working.** The replay engine is the heart of the project; behavioral changes need a manual test run against a real questionnaire.

## Local setup

```bash
git clone https://github.com/sadult/huckleberry.git
cd huckleberry
./build.sh                     # writes dist/huckleberry-firefox.zip and dist/huckleberry-chrome.zip
```

Load the unpacked source directly while developing:

- **Firefox** — `about:debugging#/runtime/this-firefox` → *Load Temporary Add-on* → `manifest.json`
- **Chrome** — `chrome://extensions` → *Developer mode* → *Load unpacked* (rename `manifest.chrome.json` to `manifest.json` first, or load the built Chrome zip)

## Checks before opening a pull request

```bash
# syntax check every script
for f in background.js sidebar/sidebar.js options/options.js content/*.js ai/*.js; do node --check "$f" || exit 1; done

# validate both manifests
python3 -c "import json;[json.load(open(f)) for f in ('manifest.json','manifest.chrome.json')]"
```

Then run through this manual list:

1. Sidebar opens in both browsers and the three tabs switch cleanly.
2. Settings → Providers: add, test, activate and delete a provider.
3. Record a two-question macro and replay it end to end.
4. Force a stall (unplug the network mid-run) and confirm the assist panel appears, accepts an answer, and resumes.

## Code style

- Two-space indentation, double quotes, semicolons.
- Prefer small named helpers over long inline blocks.
- Comments explain *why*, not *what*.
- Message commands keep the `namespace:action` shape (`run:start`, `providers:test`).
- New settings must be given a default in `DEFAULT_SETTINGS` and handled in `normalizeSettings()`.

## Commit and PR conventions

- Conventional-commit prefixes are appreciated: `feat:`, `fix:`, `docs:`, `refactor:`, `chore:`.
- One logical change per pull request.
- Describe what you tested manually, and bump `CHANGELOG.md` under an `Unreleased` heading.

## Reporting bugs

Open an issue at <https://github.com/sadult/huckleberry/issues> with the browser
and version, the extension version, the steps you took, and the relevant lines
from the sidebar log. Never paste an API key into an issue.

## Scope reminder

Pull requests that aim Huckleberry at exams, graded assessments, or paid survey
fraud will be closed. The project exists to remove repetitive form-filling, not
to misrepresent a human answer.
