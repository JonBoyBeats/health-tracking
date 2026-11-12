# Setup

About 10 minutes, done once. Supabase occasionally renames menu items, so a label may differ slightly
from what's written here.

## 1. Create the Supabase project

1. Go to [supabase.com](https://supabase.com) and sign in with GitHub.
2. **New project**:
   - Name it `health-tracking` and pick the free plan.
   - Choose the region closest to you.
   - Set a database password and save it in your password manager. The app never uses it, but
     Supabase asks for it.

## 2. Lock sign-ups and add the two of you

1. **Authentication → Sign In / Providers**: turn **off** "Allow new users to sign up".
   Leave Email enabled.
2. **Authentication → Users → Add user → Create new user**, once for each of you:
   - Email and a password.
   - Check **Auto Confirm User**.

## 3. Create the tables

1. **SQL Editor → New query**.
2. Paste the whole of [`supabase/001_profiles_and_log.sql`](supabase/001_profiles_and_log.sql) and
   click **Run**. It should say "Success. No rows returned".
3. Check **Table Editor → profiles**: it should have one row for each of you.

## 4. Connect the app

1. Find the **Project URL** (on the project's home page, or under **Project Settings → Data API**).
2. Find the **publishable key** under **Project Settings → API Keys**. It starts with
   `sb_publishable_`. The older "anon" key also works.
3. Send both to Claude in chat, or paste them into [`js/config.js`](js/config.js) yourself.
   Both are designed to be public: the database only answers the two of you once signed in.

**Never share the `secret` or `service_role` key.** That key bypasses all protection.

## 5. Turn on the website

1. Merge the work into `main`.
2. In this repo on GitHub, go to **Settings → Pages**.
3. Set Source to **Deploy from a branch**, then `main` and `/ (root)`.
4. After a minute or two it's live at `https://jonboybeats.github.io/health-tracking/`.

## 6. On each iPhone

1. Open the link in Safari or Chrome and sign in.
2. Tap **Share → Add to Home Screen**. From then on, open it from the home screen icon.

## Later steps

Each later build step may add one more SQL file in `supabase/`. You run it the same way as in step 3.
