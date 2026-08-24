# Contributing

Thanks for your interest in justSpeak!

## Getting set up

See [DEPLOY.md §1](DEPLOY.md#1-local-development-hot-reload) for a hot-reload dev setup.

## Before you open a PR

- **Backend**: keep it importable — `python -m py_compile` the files you touched, and
  run the app locally to smoke-test your change.
- **Frontend**: `npm run build` in `frontend/` must pass (it runs `tsc -b` — a type error
  fails the build).
- Match the surrounding code style. The `docs/` folder documents each subsystem; read the
  relevant one before changing that area.
- Keep secrets out of commits. Never commit a real `.env`, key, or password. Configuration
  goes through `.env` / environment variables only.

## Reporting issues

Include: what you did, what you expected, what happened, and relevant logs
(`docker compose logs api`). For security issues, please report privately rather than in a
public issue.

## License

By contributing you agree that your contributions are licensed under the project's
[AGPL-3.0](LICENSE) license.
