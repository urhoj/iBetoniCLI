# @ibetoni/cli

AI-driven command-line interface for [betoni.online](https://betoni.online).

## Install

```bash
npm install -g @ibetoni/cli
```

## Quickstart

```bash
ib auth login
ib company list
ib keikka list --from 2026-06-01 --to 2026-06-07
```

## Audience

Designed for AI assistants (Claude, ChatGPT, Cursor) and CI/CD pipelines, not for direct human use. Every command:

- Outputs JSON on stdout (use `--pretty` for human-readable tables)
- Returns documented exit codes (0 success, 2 auth, 3 permission, 4 validation, 5 not-found, 6 server, 7 network)
- Has a self-contained `--help` listing flags, output shape, errors, and examples

Run `ib reference dump` to emit every command's spec as JSON for one-shot AI ingestion.

## Auth

`ib auth login` opens your browser to authenticate. Credentials are stored in `~/.ibetoni/credentials.json` with `0600` permissions.

For headless/CI use, set `IB_TOKEN` to a JWT obtained from the web app — the CLI will skip the credentials file and use the env var directly (no refresh path).

## Documentation

Full design spec: [docs/superpowers/specs/2026-05-28-ibetoni-cli-design.md](https://github.com/urhoj/betoni-online-workspace/blob/master/docs/superpowers/specs/2026-05-28-ibetoni-cli-design.md) in the workspace repo.

## License

UNLICENSED. Internal iBetoni / betoni.online tool.
