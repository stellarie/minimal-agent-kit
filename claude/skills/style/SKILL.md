---
name: style
description: Grammar, punctuation, composition, and word-choice rules for English prose. Use when you write or review a README, a docs page, a code comment, a commit message, or PR text.
---

# Style

Goal: clear, correct, plain English that the reader can act on.

The `ste` skill sets sentence length and word economy. This skill sets grammar, structure, and word choice. When the two disagree, `ste` wins.

## Composition

- Plan the shape of the text before you write it.
- Give each paragraph one topic, and start a new paragraph when the topic shifts.
- Make the actor the subject of the sentence, with a real verb.
- Use the passive only when the actor is unknown or unimportant.
- State what is true, and use `not` only to contrast or to warn.
- Choose precise nouns and strong verbs; modifiers cannot fix weak ones.
- Replace each vague claim with a specific name, figure, or example.
- Measure each number in the text, or leave it out.
- Cut every word that adds no meaning, but keep the words a term needs.
- Give parallel items the same grammatical form.
- Place each modifier directly before or after the word it changes.
- Use the present tense for behavior and the past tense for history.
- End each sentence with the element the reader must notice most.
- Revise each draft and reorder sections before you publish.

## Punctuation and grammar

- Add an apostrophe and `s` to form a singular possessive, even when the noun ends in `s`.
- Use `its` for the possessive of `it`, and never add an apostrophe to a possessive pronoun.
- Put a serial comma before the last item in a list of three or more.
- Set off a parenthetic phrase with a comma before it and a comma after it.
- Use no commas around a restrictive clause that says which item is meant.
- Put a comma before `and`, `but`, `or`, `nor`, `for`, or `yet` that joins two full clauses.
- Do not join two full clauses with a bare comma; use a semicolon or a period.
- Do not write a sentence fragment; attach it to a complete clause.
- Use a colon only after a complete clause, to introduce a list, an explanation, or a quotation.
- Use a dash only when a comma, colon, or period will not do the job.
- Make each verb agree with its real subject, not with words between them.
- Use a singular verb after each, everyone, nobody, neither, or someone.
- Use a plural verb after a compound subject joined by `and`, unless `each` or `every` begins it.
- Use `I`, `he`, `she`, `we`, `they`, and `who` as subjects; use `me`, `him`, `her`, `us`, `them`, and `whom` as objects.
- Test each half of a compound subject or object alone, then read the sentence again.
- Make the subject after an opening `-ing` phrase the actor of that phrase.

## Tone

- Keep the reader on the subject, not on your mood or wit.
- State speed, safety, and scope exactly; drop superlatives.
- Cut qualifiers such as `very`, `rather`, `little`, and `pretty`.
- Drop chatty filler, self-display, and slang from prose, commit text, and PR text.
- Use standard spelling; do not invent shortened forms.
- Do not restate what the reader can already see.
- Choose plain, familiar words over fancy ones.
- Put clarity first; split a tangled sentence into shorter ones.
- Leave personal opinion out of reference text and install steps.
- Use few figures of speech, and one metaphor for each image.
- Expand each abbreviation on first use, then use the short form.
- Write in English; use a foreign term only when no English word fits.
- Choose standard words over trendy jargon and new coinages.

## Form in Markdown

- Write a literal value, file name, or command in code formatting, not in quotation marks.
- Keep sentence punctuation outside the code span.
- Write slang and casual terms plainly, without quotation marks.
- Reserve exclamation marks for real exclamations and commands.
- Omit the final period from a heading; keep `?` or `!` when it belongs there.
- Hyphenate two or more words that jointly modify a noun, such as `long-running job`.
- Write a compound as one word when a current dictionary lists it that way.
- Write versions, dates, and numbers with units as figures, not words.
- Punctuate the sentence as if the parenthesis were absent.
- Drop the stop inside a parenthetical phrase, unless the phrase ends in `?` or `!`.
- Put the stop before the closing parenthesis only when the parenthesis holds a whole sentence.
- Set a quotation of a full line or more as a blockquote.
- Drop quotation marks from a reported statement that follows `that`.
- Italicize titles of books and long works with asterisks.

## Words

Check misused words and phrases in [words.md](words.md) before you finish.

## Examples

| Bad | Good |
|---|---|
| Set the timeout in it's config block. | Set the timeout in its config block. |
| Supports Linux, macOS and Windows. | Supports Linux, macOS, and Windows. |
| The build passed, the tests did not. | The build passed; the tests did not. |
| The flag is optional. Defaults to false. | The flag is optional and defaults to false. |
| Send the release notes to Sam and myself. | Send the release notes to Sam and me. |
| Idle connections are closed by the pool after thirty seconds. | The pool closes idle connections after thirty seconds. |
| The importer handles large files quickly. | The importer reads a 2 GB CSV in about 40 seconds on a 16 GB laptop. |
| The cache is not often stale. | The cache is rarely stale. |
| The build passes! | The build passes. |
| Run the "magic" fix to clear the cache. | Run the fix to clear the cache. |
| Name the file "config.yaml." | Name the file `config.yaml`. |
| This is a pretty small change and is very easy to review. | This change touches one file and adds no dependencies. |
| Use LRU for the ORM cache. | Use the least-recently-used (LRU) policy for the object-relational mapper (ORM) cache. |
