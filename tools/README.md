# State Capture Helper

`state-capture.html` creates a JSNES save state from your own local ROM.

1. Run `npm install` from the project root if dependencies are not installed.
2. Open `tools/state-capture.html` in a browser.
3. Select your legally owned `Super Mario Bros.nes` ROM.
4. Play or route to World 4-2.
5. Click `Download 4-2 State`.
6. Move the downloaded file to `states/world-4-2.state.json`.

Validate it with:

```powershell
node dist\cli.js validate-state --rom .\roms\smb.nes --state .\states\world-4-2.state.json
```

## Run Viewer

After generating a run with `node dist\cli.js run ... --out .\runs\world-4-2.playtest.json`, view it in JSNES with:

```powershell
node dist\cli.js view --rom .\roms\smb.nes --state .\states\world-4-2.state.json --run .\runs\world-4-2.playtest.json
```

Open the printed local URL, select a persona, and replay the stored controller inputs in the emulator.
