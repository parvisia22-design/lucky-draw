# Booth sign-up + luck draw (one app)

One website, three addresses:

| Address | Who | What |
| --- | --- | --- |
| `/` | Visitors (public) | Sign-up page: name, phone, company, consent. Shows a ticket number. |
| `/qr` | You | Printable QR code that points to `/`. |
| `/admin` | Staff (password) | Luck-draw roulette, check-in, attendee list, draw log, CSV downloads. |

No AI or Anthropic account is used by this app. It is a normal website plus a database.

## Deploy on Railway (about 15 minutes)

1. **Put the code on GitHub.** Create a new private repository and upload the files of this folder
   (not `node_modules`, not `data`). Or, with the Railway CLI instead: `npm i -g @railway/cli`, `railway login`,
   `railway init`, then `railway up` from this folder.
2. **Create the service.** In Railway: New Project, Deploy from GitHub repo, pick the repository.
   Railway detects Node.js and runs `npm start` by itself.
3. **Add the database.** In the same project: New, Database, Add PostgreSQL. This is where attendees and draws are stored,
   so nothing is lost if the app restarts.
4. **Set variables** on the app service (Variables tab):
   - `DATABASE_URL` = `${{Postgres.DATABASE_URL}}` (use "Add Reference Variable" and pick the Postgres one)
   - `ADMIN_PASSWORD` = a long password for staff (required, otherwise `/admin` stays disabled)
   - `EVENT_NAME` = your booth or company name (shown on the pages)
5. **Make it public.** Service, Settings, Networking, Generate Domain. Railway gives you an https address.
6. **Try it.** Open the address on your phone and sign up. Open `/admin` on the laptop (any username, your password).
   The new attendee appears within a few seconds. Open `/qr` and print it.
7. **Before the event:** do a trial with 5 to 10 phones at the same time, set your prize stock in the Prizes tab,
   then use "Delete everything" in the Draw log tab to clear the test data.

Do not set more than one replica/instance: the app keeps its working copy in memory and assumes a single instance.

## Google Sheet (see who came, after the event)

Every sign-up, staff check-in and draw is copied into a Google Sheet a few seconds after it happens.
The app keeps working normally if Google is slow or down; it catches up by itself.

1. Create a new Google Sheet (sheets.new). Optional: File, Settings, Time zone = (GMT+07:00) Jakarta.
2. In the sheet: Extensions, Apps Script. Delete what is there, paste the whole of `google-sheets/Code.gs`.
3. In that code, replace `PASTE-THE-SECRET-HERE` with a long random secret. Save.
4. Deploy, New deployment, type Web app. Execute as: Me. Who has access: Anyone. Deploy, allow access,
   and copy the Web app URL (ends in `/exec`).
5. On Railway, app service, Variables:
   - `SHEETS_WEBHOOK_URL` = the Web app URL
   - `SHEETS_SECRET` = the same secret as in step 3
6. Open `/admin`, Attendees tab: "Google Sheet: Up to date" means it works. "Sync now" sends everything again.

The sheet gets three tabs: **Summary** (counts), **Attendees** (ticket, time, name, phone, email, company, source) and **Draws**.
The app rewrites only its own columns, so you can add your own columns to the right (for example "Follow-up").
If you change the script later, use Deploy, Manage deployments, Edit, Version: New version (the URL stays the same).

## On the day

- Visitors scan the QR code, fill in the form and read their ticket number.
- At the wheel, type the ticket number (for example `42` or `0042`) in the box under the wheel, press Enter, and it spins.
- Visitors without a phone: use the staff check-in in the Attendees tab (tickets look like `A003`).
- Count people who only stop by with the +1 button.
- Wrong draw? Press Undo (in the pop-up or the Draw log). The prize goes back into stock.
- Projector mode hides the side panel so the wheel can be shown on a big screen.

## After the event

- Attendees tab: "Download attendance CSV". Draw log tab: "Download draw log CSV".
- Delete the data when your office rule says so (Draw log tab, Danger zone), then pause or delete the Railway service so it stops billing.

## Settings (environment variables)

| Variable | Needed | Meaning |
| --- | --- | --- |
| `ADMIN_PASSWORD` | yes | Staff password for `/admin` |
| `DATABASE_URL` | yes on Railway | Postgres connection (without it, data is kept in a local file and is lost when the host resets its disk) |
| `EVENT_NAME` | no | Name shown on the pages (default "Our Booth") |
| `SHEETS_WEBHOOK_URL` | no | Google Apps Script web app URL (see "Google Sheet") |
| `SHEETS_SECRET` | with the above | Same secret as in the Apps Script |
| `BASE_URL` | no | Public address used inside the QR code, only if the automatic address is wrong (for example a custom domain) |
| `PORT` | no | Set by Railway automatically |

## Try it on your own computer

```
npm install
ADMIN_PASSWORD=test npm start
```
Open http://localhost:3000 and http://localhost:3000/admin. Data is stored in `./data/state.json`.

## Privacy notes

Phone numbers are personal data. The page asks for consent, the staff area needs a password, and everything is sent over
https on Railway. Share the CSV files only with the people who need them and delete the data after the event.
