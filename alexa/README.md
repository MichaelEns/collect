# Joe's Collection Alexa skill

This custom skill reads the same live family collection as the web app. It
uses the existing four-word sharing code instead of Amazon account linking.
The code is stored in Workers KV under a one-way hash of the Alexa user ID. It
is never placed in the skill source or repeated in a spoken response.

On an Echo Show, opening the skill displays the same linked collection as a
touchable set and figure grid. Tapping a figure updates the same shared
progress as the PWA. An optional Widget Panel tile shows total progress and
opens the checklist. There is no second pairing, role, household, or sharing
system in the Alexa layer.

## What to say

After enabling the skill, pair each Amazon account once:

> Alexa, ask Joe's collection to use sharing code [first word] [second word]
> [third word] [fourth word].

Then ask, for example:

> Alexa, ask Joe's collection how many red Death Star guys does Joe need.

> Alexa, ask Joe's collection what's in gray Death Star code I eight.

> Alexa, ask Joe's collection what code is Queen Amidala in the red Death Star.

That reverse lookup returns every recorded code for the named figure, including
separately identified disputed collector reports.

Package color matters. The skill understands gray and red Death Stars, blue
and orange Cargo Drops, the gray AT-AT, and blue, green, and purple Toy Story
backpacks. An uncolored Death Star, Cargo Drop, or backpack prompts for the
color rather than guessing.

## Deploy

1. Deploy the credential check in `worker/src/index.js` with
   `cd worker; npx wrangler deploy`. The same deployment publishes the signed
   Alexa HTTPS endpoint at `/alexa` and makes a well-formed but unallocated
   four-word code fail pairing instead of looking like an empty collection.
2. In the [Alexa Developer Console](https://developer.amazon.com/alexa/console/ask),
   create a **Custom** skill named **Joe's Collection**, choose
   **Provision your own**, and use the **Start from scratch** template.
3. Deploy `skill-package/skill.json` and
   `skill-package/interactionModels/custom/en-US.json`. The manifest points to
   `https://collect-sync.michaelens.workers.dev/alexa`.
4. Enable **APL**, **Data Store**, and **Data Store Packages**, then deploy the
   `JoesCollectionSummary` package under `skill-package/dataStorePackages/`.
5. Set `ALEXA_SKILL_ID` in `worker/wrangler.toml`. Configure the private-image
   signing key and Alexa Skill Messaging credentials:

   ```powershell
   cd worker
   npx wrangler secret put ALEXA_IMAGE_SIGNING_KEY
   npx wrangler secret put ALEXA_CLIENT_ID
   npx wrangler secret put ALEXA_CLIENT_SECRET
   npx wrangler deploy
   ```

   Image URLs are encrypted and expire after fifteen minutes. Widget
   credentials use the `alexa::datastore` scope. The Worker verifies Amazon's
   signing certificate, request signature, timestamp, and skill ID for skill
   requests.
6. In **Test**, enable development testing and pair a test account. The code is
   validated against the collection worker before it is saved.
7. For the three family households, either invite each Amazon account to a
   90-day beta or publish the skill for durable access. A published listing
   does not expose the collection: without its four-word code the skill has no
   data to read. Use the included privacy-policy and terms URLs during
   certification.

Alexa voice history may retain what was spoken during pairing. Anyone who
learns the four words has the same collection access as a browser with that
code, so use **forget my sharing code** on an account that should no longer
have access.

## Test locally

From the repository root:

```powershell
$tests = @((Get-ChildItem .\tests\*.test.mjs).FullName) +
  @((Get-ChildItem .\tests\*.test.cjs).FullName)
node --test $tests
```

The APL tests run the actual Worker documents and data sources in Amazon's
WebAssembly APL renderer, checking visible text, layout, and touch events on
small and large Echo Show viewports. Install dependencies with
`npm ci --prefix worker`; Windows uses installed Edge, while Linux uses
`cd worker; npx playwright install --with-deps chromium`.

Full-screen documents use APL 1.3 components, including a wrapping container
instead of the newer `GridSequence`. Widgets use APL 1.8 for `SendEvent`'s
`OPEN_SKILL` interaction mode. Template parameters bind the named `collection`
data source, not the reserved `payload` map.

The tests use local fixtures and never read or print a real family code.
