---
name: build-in-public
description: Draft build-in-public posts for Threads and X from the work in front of you, written to earn follows, stars, and sign-ups, not just likes. Use when work turns up a measured finding, a decision and its reasoning, a mistake, a tooling trick, or a launch, and when asked to draft, rewrite, or learn from a post.
---

# Build in public

A post is worth drafting when someone who has never heard of the product would still get something out of it, or when the product itself changed (a launch, pricing). Draft it in the same change as the work, while the sources are fresh. Every post does two jobs: the **hook** earns the like, and the **bridge** turns the like into a follow, a star, or a sign-up. A great hook with no bridge buys likes and nothing else.

## 1. Find the bridge

Before writing, name the line from this lesson to what you build, in one sentence. The best lessons come out of the product's core problem, so a reader curious about the trick is already curious about the product: "copied my browser cookies to a datacenter server and stayed signed in" sells a product that syncs sign-ins; "our version numbers are dates" sells nothing in particular. If the bridge is weak, still post it, but lean harder on step 4.

## 2. Write the post

- **Hook first.** Only the first post shows in the feed, so it carries the hook, the main claim, and the picture. Open with the surprising fact, the number, or the tension, and land it in the first 280 characters (X Premium shows that much before "Show more").
- **Name what you build** in one clause the reader understands, inside the post: "my Chrome extension that keeps AI agents signed in", never just "our extension" or the product name alone. That clause is what makes a reader who liked the trick look at the profile.
- **Casual, concise, punchy.** First person, short sentences, plain words, fragments welcome. Cut every word that doesn't earn its place. Plain text: the hook carries it, with no hashtags or emoji.
- **One post** (up to 500 characters on Threads) when the idea fits. A thread only when it has separate beats that each pay off alone, usually 2 to 4 posts, each split at the end of a thought. Tables and long detail go in an attachment or the reply.
- **Accurate.** Every claim matches a source you can link; casual never means overstated.
- **Public.** Write only what you'd show a stranger: no private repo names, issue numbers, internal hostnames, secrets, customer or user data, or your provider costs and margins.

**Where:** a community and its one topic tag when the lesson stands alone (findings, how-tos, tricks, mistakes), mentioning the product lightly; those find new readers. The profile for launches, pricing, and product changes.

## 3. Make the picture

A post with a picture stops the scroll, so give the first post one whenever it shows something the text can't. Skip it only for a pure opinion with nothing to show.

- **The number is the picture.** One big artifact (a version string, a count, a command, a line of output, a before and after) set huge and taken apart with labels, so the reader decodes it in two seconds. Our best-liked post so far was one: a version number taken apart into the date it encodes.
- **Real screenshots** when the thing exists: the site, the app, a terminal. Crop to the part that matters and blur personal details (addresses, other people's names and faces, emails, tokens).
- **Drawn mocks** when a screenshot can't show it or would leak something: a chart, a diagram, a terminal window, a quote. Draw it as HTML on one shared stylesheet in the site's theme and render it to PNG at 2x. Every number, line of output, and quote in it comes from the post's sources, as exactly as the text does.
- **Shape:** 1080 px square, or 4:5 portrait when it needs the height. Text readable on a phone, no more of it than the post's own. Sign every drawn mock with the site's name, small, bottom left; a screenshot travels without the post.

## 4. Write the reply

Every post gets a first reply, posted right after it, and links go there, keeping the post itself link-free. It gives the reader who liked the post a next step:

- **A star:** link the exact file or commit in the public repo that does what the post describes, so a reader lands on code they want, then one line on what the repo is.
- **A sign-up:** the site, with what someone gets in their first minute.
- **A follow:** a "Next:" line naming the post that follows, or what you post about ("building X solo, posting what breaks").

Pick the one or two that fit. Then reply to every comment for the first hour.

## 5. File the draft

File it where the project keeps its post queue (its agent instructions or content guide say where); with none, one GitHub issue per post, labelled `content`. Title it with the hook in a few words. The body:

- **Where:** the community and its topic tag, or the profile and a tag.
- **Sources:** what each claim comes from, as links to files and commits.
- **Check before posting:** anything unverified or to attach, and posts this one must follow.
- The picture for the first post.
- `## Post`, or `## Thread` with `**1/**`, `**2/**` before each post, then `## Reply`. Each post in its own `text` code block, so it copies exactly with one tap.

## 6. Learn from the numbers

A day after posting, record the post's URL and its numbers on the draft: likes, replies, reposts, new followers, and the stars and sign-ups that day. Likes measure the hook; follows, stars, and sign-ups measure the bridge. When a post's numbers teach something (a hook shape that carried, a bridge that converted or didn't), fold the rule into this skill, replacing whatever it outdates.
