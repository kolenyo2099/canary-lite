# Canary Privacy Policy

Last updated: September 30, 2026

Canary is a Chrome extension that collects and triages news data for your research projects. It runs entirely in your browser. There is no Canary server.

## What we collect

Nothing. The developer receives no data from the extension: no analytics, no telemetry, no crash reports and no accounts.

## What is stored on your device

- Your projects, queries, collected results, triage labels and notes, stored in your browser's IndexedDB.
- Settings you enter, such as a Media Cloud API token, a Bluesky app password or a Google Apps Script URL, stored locally.
- Article snapshots you choose to archive, saved as MHTML files in your Downloads/Canary folder.
- Language models you choose to download, cached in your browser.

This data stays on your device. It is removed when you delete it in Canary, uninstall the extension or clear your browser data. Archived files in your Downloads folder stay there until you delete them.

## Network requests the extension makes

To do its job, Canary connects directly to these services:

- **GDELT (data.gdeltproject.org)**: downloads public event and article data files.
- **Google News (news.google.com)**: fetches RSS feeds for your search queries.
- **Media Cloud (search.mediacloud.org)**: runs your queries using your own API token. This happens only if you set it up.
- **Google Apps Script (script.google.com)**: sends results to a Google Sheet you control. This happens only if you set it up.
- **X (x.com)**: opens the searches in your X rules on x.com in a background tab, signed in with your own X account, and keeps the posts they return. This happens only if you add X rules and allow access to x.com.
- **Bluesky (bsky.social and your account's Bluesky server)**: signs in with the app password you connect and runs the searches in your Bluesky rules. This happens only if you add Bluesky rules.
- **Hugging Face (huggingface.co)**: downloads a language model that then runs on your device. This happens only if you turn that feature on.
- **Article websites**: loads the pages of articles you collect to read their metadata or to archive them, with your permission.

These services receive the requests they need, such as your search query and your IP address, and their own privacy policies apply. Canary does not send your collected data to any of them, except the Google Sheet you configure yourself.

## Sharing and sale

We do not sell, share or transfer your data, and we do not use it for advertising or for credit decisions. The use of any information by the extension follows the Chrome Web Store User Data Policy, including its Limited Use requirements.

## Changes

If this policy changes, we will update this page and its date.

## Contact

guillentorres@gmail.com
