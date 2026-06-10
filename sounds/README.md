# Sound files

Real recordings used by the game (loaded on first tap; synthesized fallback if
a file is missing, so deleting any of these never breaks the game):

| File | Used for |
|---|---|
| `freesound_community-shuffle-cards-46455.mp3` | shuffling at each deal |
| `oxidvideos-placing-playing-card-522514.mp3` | playing a card |
| `freesound_community-hard-punch-90179.mp3` | hard-punch slam (Ctrl/⌘-click or long-press) |
| `dragon-studio-cartoon-lion-roar-487672.mp3` | lion roar — your clean trick wins + the 🦁 attack |
| `dragon-studio-bubble-gum-popping-467465.mp3` | pop — emoji reactions |
| `dragon-studio-dragon-growl-7-364612.mp3` | 🐉 dragon attack |
| `dragon-studio-i-see-you-creepy-ghost-whisper-401711.mp3` | 👻 ghost attack |
| `eaglaxle-gaming-victory-464016.mp3` | you win the game |
| `ribhavagrawal-you-loseheavy-echoed-voice-230555.mp3` | you lose the game |
| `poorartistt-joyful-female-laughing-sound…mp3` | mocking laugh when someone is stuck with the Black Queen |

## Drop-in overrides

Add any of these files here and the game uses them automatically instead of
the synthesized version — no code changes needed:

| Filename | Replaces |
|---|---|
| `click.mp3` | interface clicks |
| `deal.mp3` | dealing cards |
| `trick-win.mp3` | winning a hand |
| `round-end.mp3` | round-complete chime |
| `error.mp3` | illegal move |
| `bomb.mp3` | 💣 bomb attack (whistle + explosion in one file) |
| `skull.mp3` | 💀 doom attack |

(The exact filenames in use are set in `SAMPLE_URLS` in `js/sound.js` — to
re-map a sound, change the path there.)

Good free sources: freesound.org (CC0 filter), pixabay.com/sound-effects.
Keep files short (< 2 s) and mp3/ogg/wav.
