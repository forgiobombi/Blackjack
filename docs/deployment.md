# Production deployment

## Free-tier limits

Verified on 20 November 2026. Keep Cloudflare and Supabase on their Free plans.

| Service                    | Relevant Free plan limits                                                                                                                                                                                                   |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GitHub Pages               | GitHub Free supports public repositories. Published site limit 1 GB, soft bandwidth limit 100 GB/month.                                                                                                                     |
| GitHub Actions             | Standard GitHub-hosted runners are free in public repositories. Storage and runner limits apply.                                                                                                                            |
| Cloudflare Workers         | 100,000 requests/day, 10 ms CPU per Worker invocation.                                                                                                                                                                      |
| Cloudflare Durable Objects | SQLite, alarms and WebSocket Hibernation. 100,000 billed requests/day and 13,000 GB-seconds/day. Incoming WebSocket messages count at 20:1. SQLite includes 5M rows read/day, 100K rows written/day and 5 GB total storage. |
| Cloudflare D1              | 5M rows read/day, 100K rows written/day, 5 GB total storage, 500 MB per database and 10 databases. Time Travel retention is seven days.                                                                                     |
| Supabase Auth              | 50,000 monthly active users and two active projects. Projects pause after a week of inactivity. Custom SMTP is included.                                                                                                    |
| Example SMTP option        | Brevo Free includes 300 sends/day with verified sender setup.                                                                                                                                                               |

- [Pages limits](https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits)
- [Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions)
- [Workers limits](https://developers.cloudflare.com/workers/platform/limits/)
- [Durable Object pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)
- [Durable Object limits](https://developers.cloudflare.com/durable-objects/platform/limits/)
- [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/)
- [D1 limits](https://developers.cloudflare.com/d1/platform/limits/)
- [Supabase pricing](https://supabase.com/pricing)
- [Supabase SMTP](https://supabase.com/docs/guides/auth/auth-smtp)
- [Brevo Free limits](https://help.brevo.com/hc/en-us/articles/208580669-FAQs-What-are-the-limits-of-the-Free-plan)

Supabase's built-in mail service can send two emails per hour and only to team addresses. Configure custom SMTP before registering friends. A paused Supabase project can be resumed from its dashboard. Daily quotas are shared with other resources on the provider account.

## 1. Configure Supabase Auth

1. Create a dedicated Free project. Enable email and **Confirm email** in Authentication. Set the minimum password length to at least 10 characters.
2. Configure custom SMTP in Authentication and set the app's HTTPS URL as the Site URL.
3. Use the confirmation and recovery [email templates](email-templates.md). They send numeric codes for the Worker-hosted forms. The app has a fixed Worker-to-Pages return URL. For an optional Supabase redirect allowlist, use the canonical HTTPS app and Worker auth URLs.
4. Copy the project URL and the key beginning with **sb_publishable_**. The Worker verifies each access token using the Supabase Auth user endpoint.

## 2. Deploy the Cloudflare Worker

Create the D1 database in the Cloudflare dashboard or from the repository root:

    npx wrangler login
    npx wrangler d1 create blackjack-royale

Record the returned database UUID. Wrangler creates the SQLite Durable Object namespace using **new_sqlite_classes**. Keep both Cloudflare resources on Workers Free. In GitHub create the **production** environment and add these values. For deployment from your terminal, export the same environment variables.

| Name                     | Type                 | Value                                                                                                 |
| ------------------------ | -------------------- | ----------------------------------------------------------------------------------------------------- |
| CLOUDFLARE_ACCOUNT_ID    | Environment variable | Cloudflare account ID                                                                                 |
| D1_DATABASE_ID           | Environment variable | D1 database UUID                                                                                      |
| APP_URL                  | Environment variable | Canonical HTTPS frontend URL, including **/Blackjack/** for project Pages or **/** on a custom domain |
| SUPABASE_URL             | Environment variable | Project HTTPS URL                                                                                     |
| SUPABASE_PUBLISHABLE_KEY | Environment variable | Supabase publishable key                                                                              |
| CLOUDFLARE_API_TOKEN     | Environment secret   | Permissions to deploy the Worker and migrate D1 in the target account                                 |
| AUTH_BRIDGE_KEY          | Environment secret   | Generate with **openssl rand -hex 32** and retain across deployments                                  |
| VITE_API_URL             | Repository variable  | HTTPS Worker origin, without a trailing slash                                                         |

The workflows also read these settings from **Environment secrets** in **production** when the corresponding variable is empty. **CLOUDFLARE_API_TOKEN** and **AUTH_BRIDGE_KEY** always use secrets.

Run **Deploy Cloudflare Worker** in GitHub Actions or **npm run deploy:worker**. Verify the Worker at **/api/health** and test real verification email delivery with a non-team email address. The Worker derives CORS and socket-origin policy from **APP_URL**. The Pages build adds the Worker origin to its Content Security Policy.

## 3. Deploy GitHub Pages

Open repository **Settings → Pages** and select **GitHub Actions** as Source. Set **VITE_API_URL** to the Worker origin and optionally **VITE_SITE_NAME**. Run **Deploy GitHub Pages**. The workflow uses the Pages base path automatically. Invitation fragments work beneath that base path. Each deploy verifies that the public HTTPS URL serves its commit. While the repository is still configured to deploy from a branch, the Actions workflow waits for that build to finish first.

The Pages build accepts **VITE_API_URL** and **VITE_SITE_NAME** as repository variables or as secrets in **production**. Both values are public in the built site. For a **workers.dev** origin the deployment workflows use the Worker name from **apps/worker/wrangler.jsonc** and the Cloudflare account subdomain from **VITE_API_URL**. A custom Worker domain can be entered directly.

For a custom domain, use the records shown in Pages settings and turn on **Enforce HTTPS** after GitHub issues its certificate. Set **APP_URL** and the Supabase Site URL to the same HTTPS frontend address.

## 4. Bootstrap the first host

Register and verify the intended host, then sign in to create the host's D1 profile. Copy the account UUID from **Supabase → Authentication → Users**. From an authorized terminal with **D1_DATABASE_ID** set:

    npm run admin:bootstrap -- VERIFIED_USER_UUID --remote

The output should show **superadmin**. This setup applies only while no super administrator exists. Reload the lobby. The super administrator can appoint further hosts from the administration page.

## 5. Verify and operate

- Play through a round in two independent browser sessions. Verify both a link and a code, and test split or double, reconnection and the resulting wallet entries.
- Check Worker CPU, D1 row usage and Durable Object duration in the Cloudflare dashboard. Exceeding a Free quota temporarily stops the affected operations.
- Back up D1 with **wrangler d1 export**. Keep exported data private. For Time Travel recovery, stop traffic and reconcile the cutoff against Durable Object states and operation IDs. A D1-only rollback during a round can roll back ledger entries that the table has committed.
- Confirm the privacy operator and contact details for the actual installation before inviting players.
