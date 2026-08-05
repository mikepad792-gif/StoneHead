# Contributing to StoneHead AI

Thanks for reading the code. Before anything else, one thing has to be clear
about what this repository is.

## This project is not open source

The code is public so it can be read and reviewed. It is **not** licensed for
reuse. See [`LICENSE`](LICENSE) — all rights reserved. No permission is granted
to use, copy, modify, merge, publish, distribute, sublicense, or sell any part
of this software.

Reading it, learning from it, and pointing out problems in it are all welcome.
Copying it into something else is not.

## Pull requests require a signed ICLA

**A pull request cannot be merged until its author has signed an Individual
Contributor License Agreement.** This applies to every contributor, including
one-line fixes.

GitHub's terms give a repository owner an inbound license matching the
outbound one. Since there is no outbound license here, that clause has nothing
to attach to — which means without a signed agreement, contributed code has
unclear ownership. That is bad for the project and bad for the contributor. The
ICLA is how both sides end up with a clear answer.

If you want to contribute:

1. Open the pull request as normal.
2. Note in the description that you're willing to sign the ICLA.
3. You'll get the agreement to sign before review concludes.

If you'd rather not sign one, that's a completely reasonable position — please
open an issue describing the problem instead of a PR with the fix. A clear bug
report is genuinely useful and carries none of the IP questions.

## Reporting problems

Issues are the best channel for:

- Bugs, with the steps that reproduce them
- Anything StoneHead said that it shouldn't have — the exact conversation
  matters more than a summary
- Security findings; if it looks sensitive, say so in the issue and hold the
  detail until someone replies

Safety findings deserve their own note: the crisis and substance intercepts in
`lib/` are the parts of this codebase where being wrong is most expensive. If
you've found a phrase that should have been caught and wasn't, or one that
fires when it shouldn't, that report is worth more than most patches.
