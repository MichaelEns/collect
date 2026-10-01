# Joe's Collection Alexa skill

This custom skill reads the same live family collections as the web app. It
uses four-word owner or sharing codes instead of Amazon account linking. Codes
are stored in Workers KV under a one-way hash of the Alexa user ID. They are
never placed in the skill source or repeated in a spoken response.

One Alexa account can link several independent collections. For example, the
Echo at Grandma's house can select Joe's contributor-shared collection or
Grandma's house-only collection without merging their progress.

On Echo Show, launch displays a responsive collection overview. Tap a set to
open its figure grid; owner and contributor links may mark a figure found,
while a viewer link is read-only. Personal or privately seeded pictures use
15-minute encrypted image URLs that do not disclose the collection code. The
included widget shows the selected collection's total in the Widget Panel and
opens the full checklist when tapped.

## What to say

After enabling the skill, pair each Amazon account once:

> Alexa, ask Joe's collection to use sharing code [first word] [second word]
> [third word] [fourth word].

Then ask, for example:

> Alexa, ask Joe's collection how many red Death Star guys does Joe need.

> Alexa, ask Joe's collection what's in gray Death Star code I eight.

> Alexa, ask Joe's collection what code is Queen Amidala in the red Death Star.

With more than one collection linked:

> Alexa, ask Joe's collection which collections are linked.

> Alexa, ask Joe's collection to switch to Grandma's House.

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
4. Enable **APL**, **Data Store**, and **Data Store Packages** for the skill.
   Deploy the `JoesCollectionSummary` package under
   `skill-package/dataStorePackages/`.
5. Set `ALEXA_SKILL_ID` in `worker/wrangler.toml` to the created skill ID.
   Configure the private image key:

   ```powershell
   cd worker
   npx wrangler secret put ALEXA_IMAGE_SIGNING_KEY
   ```

6. Create Alexa Skill Messaging/Login with Amazon credentials with the
   `alexa::datastore` scope, then configure them so the widget can refresh:

   ```powershell
   npx wrangler secret put ALEXA_CLIENT_ID
   npx wrangler secret put ALEXA_CLIENT_SECRET
   npx wrangler deploy
   ```

   The Worker verifies Amazon's signing certificate, request signature,
   timestamp, and skill ID before handling a skill request. Widget image
   requests are independently protected with short-lived AES-GCM tokens.
7. In **Test**, enable development testing and pair a test account. The code is
   validated against the collection worker before it is saved.
8. For the family households, either invite each Amazon account to a
   90-day beta or publish the skill for durable access. A published listing
   does not expose the collection: without its four-word code the skill has no
   data to read. Use the included privacy-policy and terms URLs during
   certification.

Alexa voice history may retain what was spoken during pairing. A code has the
same owner, contributor, or viewer authority in Alexa as in the PWA. Use
**forget my sharing code** to unlink the selected collection, or **forget every
collection** to remove all saved codes from that Alexa account. Revoke a share
code in the PWA when every device using it should lose access.

## Test locally

From the repository root:

```powershell
$tests = @((Get-ChildItem .\tests\*.test.mjs).FullName) +
  @((Get-ChildItem .\tests\*.test.cjs).FullName)
node --test $tests
```

The tests use local fixtures and never read or print a real family code.
