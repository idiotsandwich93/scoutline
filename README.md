# Scoutline

Scoutline is a local-first desktop workspace for music producers and A&R teams. It brings artist discovery, identity verification, contact management, outreach, replies, files, packs, automations, and release utilities into one application.

> **Development status:** active work in progress. This repository contains the current source and local demo; no public release has been published.

## Current development build (0.6.1)

The current vertical slice includes:

- Artist discovery from Spotify, Last.fm, MusicBrainz, ListenBrainz, and optional Chartmetric data
- Monthly-listener, location, Instagram-follower, and public-email discovery criteria
- One-at-a-time prospect review with Spotify releases, artwork, and embedded playback
- Evidence-backed Spotify-to-Instagram identity matching and confidence scoring
- Latest-release personalization for outreach messages
- Contacts CRM with relationship status and outreach history
- Chartmetric, Viberate, and custom CSV import and field mapping
- A focused inbox model for replies from artists already contacted in Scoutline
- Campaign queues, configurable pacing, files, packs, and recurring automations
- YouTube publishing workflow and practical producer utilities
- Provider-neutral AI support for Codex/ChatGPT, Claude, and Gemini sessions
- SQLite-backed local state and audit history

Connection sessions and application data remain local to the desktop app.

## Run locally

The Codex desktop bundled Node runtime was used for this workspace. With Node 22+ available:

```sh
pnpm install
pnpm dev
```

Build and test:

```sh
pnpm test
pnpm build
```

Package for macOS:

```sh
pnpm package:mac
```

## Local data

Electron persists application state to `scoutline.sqlite` under the macOS application-data directory. Browser preview mode uses localStorage. No Scoutline-defined finder, outreach, storage, automation, or AI usage quota exists.
