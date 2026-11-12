# Health Tracking: v1 spec

A macro and weight tracker for two people (Jon and his wife), used on two iPhones
(one in Safari, one in Chrome). Lives at `jonboybeats.github.io/health-tracking`.

**Status: draft for approval. Nothing is built yet.**

## v1 is done when

1. Both of us can log a typical meal by speaking or typing a sentence, answer at most one or two
   follow-up questions, and confirm, in under about 30 seconds.
2. Scanning a barcode logs the product with the exact numbers on its label.
3. After every entry, the app shows what is left for the day: calories, protein, carbs, fat, fiber.
4. Either of us can log for the other, or for both at once ("we split a pizza").
5. Both phones stay signed in after the first login.
6. Weight entry with a trend line works.

## Not in v1

- Adaptive or "smart" targets from weight trend (targets are set by hand)
- Importing MyFitnessPal history
- Micronutrients beyond fiber
- Charts beyond the weight trend

## Platform

- **No build step.** Plain HTML, CSS and JavaScript, the same as `br_rankings`, split into a few
  files by feature. Served by GitHub Pages from `main`.
- **Outside libraries:** `supabase-js` (database and login) and a barcode scanner library (ZXing)
  that works in iPhone Safari. Both are pinned to exact versions.
- **Look:** the same dark theme as the sports site. A "Health" card is added to the hub page.
- **Home screen app:** installable from Safari or Chrome (Share → Add to Home Screen). It opens
  full screen and keeps its data. Every iPhone browser uses Safari's engine underneath, so both of
  us get the same behavior.
- **Login:** email and password, once per phone. Sessions refresh themselves. Public sign-up is
  turned off; the two accounts are created by hand.
- **Voice:** the iPhone keyboard's mic is the supported path. An in-app mic button may be added if
  it works reliably in the home screen app.

## Backend (Supabase, free tier)

- **Postgres database** with row-level security. Only signed-in users can read or write, and the
  only users are us two, so both of us can see and log everything.
- **Edge Functions** (server code) hold every secret key, so no key is ever in the repo or the page:
  - `assist`: the AI logging conversation (Claude Opus 5.5)
  - `food-search`: searches every food source at once and returns ranked results
  - `barcode`: looks up a barcode
- The Supabase project URL and public "anon" key do go in the page. That is by design and is safe
  with row-level security turned on.

## Screens

1. **Today**
   - A "left today" bar at the top: calories, protein, carbs, fat and fiber, against target.
   - The day's log below it, grouped as Breakfast, Lunch, Dinner and Snacks.
   - A toggle between my day and hers. A date picker to view other days.
   - Tap an entry to edit the amount, change the meal, or delete it.
2. **Add** (one screen, three ways in)
   - A text box: "what did you eat?" Type it or use the keyboard mic.
   - A **Scan** button for barcodes.
   - A **Recent & saved** list to re-log with one tap.
   - "Who ate this? Me / Her / Both" and the meal (picked from the time of day, can be changed).
3. **Confirm card** (shown before anything is saved)
   - Each item with its amount, source and macros, and the total.
   - "Left after this" for each person.
   - Amounts can be adjusted inline. One tap saves.
4. **Foods & Recipes**
   - The shared food list: search, edit, delete.
   - Recipe builder: ingredients and amounts plus the number of servings gives macros per serving.
     The AI can also turn a pasted recipe into one.
5. **Weight**
   - Enter today's weight in pounds.
   - The list of entries and a trend line (a smoothed average, so daily water swings don't show).
6. **Settings**
   - Each person's daily targets: calories, protein, carbs, fat and fiber.
   - Sign out.

## AI logging flow (`assist`)

1. The user's sentence (plus who and which meal) goes to Claude Opus 5.5.
2. Claude splits it into items and amounts. It asks a follow-up question only when the answer
   changes the numbers meaningfully (at most one or two questions). For "Both", it asks whether
   amounts were the same for each person.
3. For each item, Claude calls `food-search` and picks the best match. **Claude never makes up
   nutrition numbers when a database match exists.**
4. If no source matches, the app offers, in this order:
   1. Take a photo of the label. Claude reads the Nutrition Facts panel, and the numbers are shown
      for confirmation, then saved as a food.
   2. Type the numbers in by hand.
   3. Log an AI estimate, saved with an **Estimate** badge. This is mainly for restaurant food
      with no label.
5. The result comes back as the Confirm card. Nothing is saved until the user taps it.

## Food sources

All are queried at once, and results are cached in our database.

| Source | Key | Good for |
|---|---|---|
| Our saved foods | n/a | Anything we have confirmed before. Always checked first |
| Open Food Facts | none | Barcode lookup, packaged foods |
| USDA FoodData Central | free key | Lab-measured whole foods, manufacturers' own label data, generic dishes |
| FatSecret Platform (Basic, free) | free key | Brands and chain restaurants (search only; its barcode lookup is a paid feature) |

Other free sources (for example Edamam, Spoonacular, CalorieNinjas) are added only if their free
terms allow this kind of app.

**Trust order:** our confirmed foods → exact barcode match → USDA lab data → other brand matches.

**Checks** (numbers are never averaged across sources):
- **Calorie math:** protein × 4 + carbs × 4 + fat × 9 should be close to the listed calories.
  Entries that miss badly rank lower.
- **Source agreement:** if the top sources disagree by more than about 10–15%, the Confirm card
  shows the difference and lets us pick.
- Anything we confirm is saved to our food list and is used first from then on.

## Units

- Body weight: pounds.
- Food amounts: oz, g, lb, cups, tbsp, tsp, ml, fl oz, servings, "each". Every food stores its
  grams per serving, so all units convert.
- Nutrients tracked: calories, protein, carbs, fat, fiber.

## Data model

- `profiles`: id (the login user), name, targets for calories, protein, carbs, fat and fiber
- `foods`: name, brand, barcode, nutrients per 100 g, servings (list of label + grams), source and
  source id, is_estimate, created_by
- `recipes`: name, number of servings, created_by
- `recipe_items`: recipe, food, grams
- `log_entries`: who ate it, who logged it, date, meal, food or recipe, description, amount and
  unit, grams, nutrients at the time of logging (so later edits to a food don't change past days),
  is_estimate
- `weights`: person, date, pounds

## Build order

Each step ends with a version you can try on your phones.

1. Login, targets, the Today screen and manual entry (usable from day one).
2. Food search across all sources, plus barcode scanning.
3. AI logging by text or voice, with follow-up questions, label photos and estimates.
4. Recipes, weight tracking, the home screen app, and the card on the hub page.

## Setup you'll do (I'll give exact steps at each point)

1. **Supabase:** create a free project, turn off public sign-ups, and create our two accounts.
   Note: free projects pause after a week with no use, which won't matter with daily logging.
2. **Anthropic Console:** create an API key. Set a monthly spending limit, for example $20.
3. **USDA FoodData Central:** sign up for a free key.
4. **FatSecret Platform:** create a free developer account.

Keys are pasted into Supabase's secret settings, never into chat or the repo.

## Risks to check early

- **FatSecret:** its API may require a list of allowed server IP addresses, which may not suit
  Supabase Edge Functions. If so, FatSecret is dropped or reached another way.
- **Barcode scanning in the home screen app:** camera access from a home screen app on iPhone is
  tested in step 2. If it isn't reliable, scanning opens in the browser instead.
- **AI cost:** Opus 5.5 is roughly 1–3¢ per logged meal (label photos cost a little more). The
  spending limit caps it.
