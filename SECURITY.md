# Security

## How Shelf protects you

**The web page can't touch your files.** Browsers don't let web pages rename or move files.
Shelf only reads the names of files you choose. The actual renaming is done by a small
script that you download, can read in any text editor, and run yourself.

**The scripts treat every name as plain text.** File names and movie titles can contain
characters that mean something to a computer shell, such as `'`, `` ` ``, `$( )`, `;`, `&`,
`[ ]`, `*` and curly quotes. Shelf quotes every name so it can never run as a command.

- On Mac and Linux, names are wrapped in single quotes with `'` escaped.
- On Windows, names are wrapped in PowerShell single quotes. All four kinds of single quote that
  PowerShell recognises are escaped. Files are moved with .NET file calls, which don't treat
  `[ ]` or `*` as wildcards.

**Names can't escape the library folder.** Titles from online databases are cleaned before
use:

- Slashes, `..` and leading dots are removed.
- Control characters and invisible "direction" characters are removed.
- Names Windows reserves (`CON`, `NUL`, `COM1` and so on) are made safe.
- Very long names are shortened.

**Nothing is ever overwritten.** If a file already exists at the destination, it is skipped.

**Undo is careful.**
- *Move:* undo only moves a file back if its old spot is still empty.
- *Copy:* undo only deletes the copy if it is still identical to the original.
- *Hard link:* undo only deletes the link if it is still the same file as the original.

**The page is locked down.**
- A strict Content Security Policy allows only Shelf's own code, and only connections to TMDB
  and TVmaze. There is no inline code, no third-party scripts, and no `eval`.
- All text from the internet is displayed as text, never as HTML.
- Links and images from the lookup services are checked against an allow-list of addresses.

## Tests

```
node tests/parser.test.js     # filename parsing, matching, naming
node tests/scripts.test.js    # runs the real rename + undo scripts on hostile file names
PWSH=/path/to/pwsh node tests/scripts.test.js   # also tests the Windows (PowerShell) scripts
```

## Reporting a problem

If you find a security or privacy problem, please open an issue on this repository. Don't
include any API keys or personal file names in it.
