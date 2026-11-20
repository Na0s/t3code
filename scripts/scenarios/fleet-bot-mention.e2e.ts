import * as HostProcess from "@t3tools/shared/HostProcess";
import { expect } from "e2e";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { T3_HOME } from "../e2e.config.ts";
import { runPromise, test, WEB } from "./t3.ts";

const settingsJson = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown));

const configureGateway = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const settingsPath = path.join(T3_HOME, "userdata/settings.json");
  const original = yield* fs.readFileString(settingsPath);
  const settings = yield* Schema.decodeEffect(settingsJson)(original);
  const gateway = path.join(T3_HOME, "synthetic-gateway.mjs");
  yield* fs.writeFileString(
    gateway,
    `console.log(JSON.stringify({bots:[{id:"design",name:"Design Bot",icon:"🎨",color:"#2dd4bf"},{id:"research",name:"Research Bot",icon:"🔎",color:"#60a5fa"}]}));`,
  );
  yield* fs.writeFileString(
    settingsPath,
    yield* Schema.encodeEffect(settingsJson)({
      ...settings,
      fleetGatewayCommand: [yield* HostProcess.ExecutablePath, gateway],
    }),
  );
  return fs.writeFileString(settingsPath, original);
});

test(
  "A Fleet bot can be selected and retains its identity in a sent mention",
  WEB,
  async ({ t3, app, browser, screen }) => {
    const restore = await runPromise(configureGateway);
    try {
      const project = await t3.project("demo");
      const thread = await t3.thread({ project, title: "Bot collaboration", messages: ["first"] });
      await t3.open(thread);
      const composer = screen.getByRole("textbox");
      await composer.fill("@Design");
      await app.screenshot("picker");
      const bot = screen.getByRole("option").filter({ hasText: "Design Bot" });
      await expect(bot).toBeVisible();
      await bot.tap();
      await expect(composer).toContainText("Design Bot");
      await app.screenshot("mention");
      await browser.keyboard.type(" please review the layout");
      await browser.keyboard.press("Enter");
      await expect(screen.getByText("second fixture turn complete")).toBeVisible();
      await app.screenshot("sent");
      await expect(screen.getByLabel("Grokbot Design Bot. Show details")).toBeVisible();
    } finally {
      await runPromise(restore);
    }
  },
);
