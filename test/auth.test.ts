import assert from "node:assert/strict";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  cookiesToHeader,
  loadFacebookCookies,
  loadFacebookCookiesFromFile,
  saveFacebookCookiesToFile,
  resolveChromeProfile,
  loadFacebookSessionFlexible,
} from "../src/facebook/auth.js";

function withSessionFile(
  content: string,
  run: (filePath: string) => void,
): void {
  const directory = mkdtempSync(join(tmpdir(), "facebook-session-test-"));
  const filePath = join(directory, "session.json");
  writeFileSync(filePath, content, { mode: 0o600 });
  try {
    run(filePath);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

const futureExpiry = Math.floor(Date.now() / 1000) + 3600;
const validCookies = [
  {
    name: "c_user",
    value: "test-user",
    domain: ".facebook.com",
    path: "/",
    expirationDate: futureExpiry,
    secure: true,
    httpOnly: true,
  },
  {
    name: "xs",
    value: "test-session",
    domain: ".facebook.com",
    expirationDate: futureExpiry,
  },
];

test("loads the login session format", () => {
  withSessionFile(JSON.stringify({ version: 1, userAgent: "Browser/150", cookies: validCookies }), (filePath) => {
    const cookies = loadFacebookCookies({ sessionFile: filePath });
    assert.deepEqual(cookies.map(cookie => cookie.name), ["c_user", "xs"]);
    assert.equal(cookies[0].httpOnly, true);
  });
});

test("refuses to overwrite a symbolic-link session file", () => {
  const directory = mkdtempSync(join(tmpdir(), "facebook-session-test-"));
  const target = join(directory, "target.json");
  const link = join(directory, "session.json");
  writeFileSync(target, "keep me", { mode: 0o600 });
  symlinkSync(target, link);
  try {
    assert.throws(
      () =>
        saveFacebookCookiesToFile(link, [
          {
            host: ".facebook.com",
            name: "c_user",
            value: "test-user",
            path: "/",
            expires: futureExpiry,
            secure: true,
            httpOnly: true,
          },
          {
            host: ".facebook.com",
            name: "xs",
            value: "test-session",
            path: "/",
            expires: futureExpiry,
            secure: true,
            httpOnly: true,
          },
        ], "Browser/150"),
      /not a symbolic link/,
    );
    assert.equal(readFileSync(target, "utf8"), "keep me");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("rejects files with missing, expired, or non-Facebook session cookies", () => {
  withSessionFile(
    JSON.stringify({ version: 1, userAgent: "Browser/150", cookies: [{ ...validCookies[0], expirationDate: 1 }] }),
    (filePath) => {
      assert.throws(
        () => loadFacebookCookiesFromFile(filePath),
        /no active c_user cookie/,
      );
    },
  );

  withSessionFile(
    JSON.stringify({ version: 1, userAgent: "Browser/150", cookies: [
      { ...validCookies[0], domain: ".example.com" },
      validCookies[1],
    ] }),
    (filePath) => {
      assert.throws(
        () => loadFacebookCookiesFromFile(filePath),
        /not scoped to facebook\.com/,
      );
    },
  );
});

test("reports invalid sessions without exposing cookie values", () => {
  withSessionFile(JSON.stringify({ version: 1, userAgent: "Browser/150", cookies: [{ name: "c_user", value: "secret" }] }), filePath => {
    assert.throws(() => loadFacebookCookies({ sessionFile: filePath }), (error: Error) => {
      assert.match(error.message, /npm run login/);
      assert.doesNotMatch(error.message, /secret/);
      return true;
    });
  });
});



test("rejects Chrome profile traversal and malformed cookie header values", () => {
  const chromeDir = mkdtempSync(join(tmpdir(), "chrome-profile-security-test-"));
  try {
    assert.throws(
      () => resolveChromeProfile("../Default", chromeDir),
      /Invalid Chrome profile name/,
    );
    assert.throws(
      () => resolveChromeProfile("..\\Default", chromeDir),
      /Invalid Chrome profile name/,
    );
  } finally {
    rmSync(chromeDir, { recursive: true, force: true });
  }

  const header = cookiesToHeader([
    {
      host: ".facebook.com",
      name: "c_user",
      value: "123",
      path: "/",
      expires: futureExpiry,
      secure: true,
      httpOnly: true,
    },
    {
      host: ".facebook.com",
      name: "bad;name",
      value: "ignored",
      path: "/",
      expires: futureExpiry,
      secure: true,
      httpOnly: true,
    },
    {
      host: ".facebook.com",
      name: "bad_value",
      value: "ignored\r\nInjected: yes",
      path: "/",
      expires: futureExpiry,
      secure: true,
      httpOnly: true,
    },
  ]);
  assert.equal(header, "c_user=123");
});

test("resolves Chrome profile display names through Local State", () => {
  const chromeDir = mkdtempSync(join(tmpdir(), "chrome-profile-test-"));
  try {
    mkdirSync(join(chromeDir, "Profile 7"), { recursive: true });
    writeFileSync(join(chromeDir, "Profile 7", "Cookies"), "");
    writeFileSync(
      join(chromeDir, "Local State"),
      JSON.stringify({
        profile: { info_cache: { "Profile 7": { name: "Marketplace" } } },
      }),
    );

    assert.equal(resolveChromeProfile("Profile 7", chromeDir), "Profile 7");
    assert.equal(resolveChromeProfile("marketplace", chromeDir), "Profile 7");
    assert.throws(
      () => resolveChromeProfile("missing", chromeDir),
      /Available: Profile 7/,
    );
  } finally {
    rmSync(chromeDir, { recursive: true, force: true });
  }
});


test("prefers a saved session but falls back to Chrome cookies when no snapshot exists", () => {
  const directory = mkdtempSync(join(tmpdir(), "session-provider-test-"));
  const defaultSessionFile = join(directory, "facebook-session.json");
  const extracted = [
    {
      host: ".facebook.com",
      name: "c_user",
      value: "chrome-user",
      path: "/",
      expires: futureExpiry,
      secure: true,
      httpOnly: true,
    },
    {
      host: ".facebook.com",
      name: "xs",
      value: "chrome-session",
      path: "/",
      expires: futureExpiry,
      secure: true,
      httpOnly: true,
    },
  ];
  let chromeLoads = 0;
  const cookieExtractor = () => {
    chromeLoads++;
    return extracted;
  };

  try {
    const chrome = loadFacebookSessionFlexible({
      defaultSessionFile,
      chromeProfile: "Marketplace",
      cookieExtractor,
    });
    assert.equal(chrome.source, "chrome");
    assert.equal(chrome.userAgent, undefined);
    assert.equal(chrome.cookies[0].value, "chrome-user");
    assert.equal(chromeLoads, 1);

    writeFileSync(
      defaultSessionFile,
      JSON.stringify({ version: 1, userAgent: "Browser/151", cookies: validCookies }),
      { mode: 0o600 },
    );
    const saved = loadFacebookSessionFlexible({
      defaultSessionFile,
      cookieExtractor,
    });
    assert.equal(saved.source, "session-file");
    assert.equal(saved.userAgent, "Browser/151");
    assert.equal(chromeLoads, 1);

    assert.throws(
      () =>
        loadFacebookSessionFlexible({
          sessionFile: join(directory, "explicit-missing.json"),
          defaultSessionFile,
          cookieExtractor,
        }),
      /explicit-missing/,
    );
    assert.equal(chromeLoads, 1);

    assert.throws(
      () =>
        loadFacebookSessionFlexible({
          defaultSessionFile: join(directory, "missing-default.json"),
          chromeProfile: "Marketplace",
          cookieExtractor: () => [],
        }),
      (error: Error) => {
        assert.match(error.message, /Chrome profile/i);
        assert.match(error.message, /c_user/);
        assert.doesNotMatch(error.message, /session file/i);
        return true;
      },
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
