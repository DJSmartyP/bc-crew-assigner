const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");

let source = fs.readFileSync(path.join(__dirname, "app.js"), "utf8")
  .replace(/^import .*;\r?\n/gm, "")
  .replace(/\r?\nboot\(\);\s*$/, "");

source += `
globalThis.stationLockApi = {
  computePlan,
  renderPlan,
  getStationLock,
  isStationLocked,
  stationLockCount,
  unlockedStationCapacity,
  rolesForShipCount,
  canonicalRoleName,
  normalizePlayerRecord,
  normalizeMissionRecord
};`;

const context = {
  console,
  firebaseConfig: { apiKey: "test" },
  ADMIN_UID: "admin",
  document: { querySelector: () => null },
  location: { search: "" },
  URLSearchParams,
  setTimeout,
  clearTimeout
};
vm.createContext(context);
vm.runInContext(source, context);

const api = context.stationLockApi;
const oneShip = (stationLocks = {}, overrides = {}) => ({
  ships: [{ id: "ship_1", name: "Takanami" }],
  stationLocks,
  overrides,
  balanceShips: false
});

const player = (id, prefs, shipPref = "") => ({
  id,
  name: id,
  prefs,
  dislikes: [],
  shipPref,
  createdAt: { seconds: 1 }
});

test("a locked station is removed from assignment and keeps its message", () => {
  const mission = oneShip({ "ship_1::Helm": "Console offline" });
  const plan = api.computePlan([player("Alex", ["Helm", "Beams", "Nav"])], mission);

  assert.equal(api.getStationLock(mission, "ship_1", "Helm").message, "Console offline");
  assert.equal(api.stationLockCount(mission), 1);
  assert.equal(api.unlockedStationCapacity(mission), 13);
  assert.equal(plan.byShip[0].allowed.includes("Helm"), false);
  assert.notEqual(plan.assignments[0].role, "Helm");
  const html = api.renderPlan(plan, mission);
  assert.match(html, />Locked</);
  assert.match(html, /Console offline/);
  assert.ok(html.indexOf(">Captain</span>") < html.indexOf(">Helm</span>"));
  assert.ok(html.indexOf(">Helm</span>") < html.indexOf(">Beams</span>"));
});

test("a station can be locked on one ship and remain usable on the other", () => {
  const mission = {
    ships: [
      { id: "ship_1", name: "Takanami" },
      { id: "ship_2", name: "Havock" }
    ],
    stationLocks: { "ship_1::Helm": "Reserved" },
    overrides: { Pat: { role: "Helm" } },
    balanceShips: true
  };
  const plan = api.computePlan([player("Pat", ["Helm", "Beams", "Nav"])], mission);

  assert.equal(plan.assignments.length, 1);
  assert.equal(plan.assignments[0].shipId, "ship_2");
  assert.equal(plan.assignments[0].role, "Helm");
});

test("a fixed assignment cannot reopen a locked Shuttle station", () => {
  const mission = oneShip(
    { "ship_1::XO": "Shuttle unavailable" },
    { Sam: { role: "XO", shipId: "ship_1" } }
  );
  const plan = api.computePlan([player("Sam", ["XO", "Captain", "Nav"])], mission);

  assert.equal(api.rolesForShipCount(mission.ships[0], 1, 1, mission, [player("Sam", ["XO"]) ]).roles.includes("XO"), false);
  assert.equal(plan.assignments.length, 0);
  assert.match(plan.error, /unavailable station/i);
});

test("a lock can create a temporary waiting place without blanking the plan", () => {
  const mission = oneShip({ "ship_1::Helm": "Console offline" });
  const players = Array.from({ length: 10 }, (_, index) =>
    player(`Crew-${String(index).padStart(2, "0")}`, ["__FLEX__", "__FLEX__", "__FLEX__"])
  );
  const plan = api.computePlan(players, mission);

  assert.equal(plan.assignments.length, 9);
  assert.equal(plan.overflow, 1);
  assert.equal(plan.error, undefined);
});

test("legacy engineering names load with the new station terminology", () => {
  const legacyPlayer = api.normalizePlayerRecord(player("Taylor", ["Engineering", "Manual engineer", "Nav"]));
  const legacyMission = api.normalizeMissionRecord(oneShip(
    { "ship_1::Manual engineer": "Corridor team" },
    { Taylor: { role: "Engineering", shipId: "ship_1" } }
  ));

  assert.equal(api.canonicalRoleName("Engineering"), "Power Management");
  assert.equal(api.canonicalRoleName("Manual Engineer"), "Damage Control");
  assert.deepEqual(Array.from(legacyPlayer.prefs), ["Power Management", "Damage Control", "Nav"]);
  assert.equal(legacyMission.overrides.Taylor.role, "Power Management");
  assert.equal(api.getStationLock(legacyMission, "ship_1", "Damage Control").message, "Corridor team");
});
