import { appendFile, readFile } from "node:fs/promises";
import path from "node:path";
import { google } from "googleapis";

const configPath =
  process.env.YOUTUBE_BROADCAST_CONFIG ||
  "config/youtube-broadcast.json";

const fileConfig = await loadBroadcastConfig(configPath);

const runtimeConfig = {
  timeZone:
    process.env.YOUTUBE_TIME_ZONE || "Asia/Tokyo",

  startTime:
    process.env.YOUTUBE_START_TIME || "10:00",

  reusableStreamId:
    process.env.YOUTUBE_STREAM_ID || "",

  playlistId:
    process.env.YOUTUBE_PLAYLIST_ID || "",

  shortIoLinkId:
    process.env.SHORT_IO_LINK_ID || "",

  updateShortIo:
    parseBoolean(process.env.UPDATE_SHORT_IO, true),

  dryRun:
    parseBoolean(process.env.DRY_RUN, false),

  targetDateInput:
    process.env.TARGET_DATE || "",
};

validateBroadcastConfig(fileConfig);
validateRuntimeConfig();
validateEnvironment();

const targetDate = resolveTargetDate(
  runtimeConfig.targetDateInput,
  runtimeConfig.timeZone,
);

const formattedDate = formatDisplayDate(
  targetDate,
  runtimeConfig.timeZone,
);

const title = renderTemplateValue(
  fileConfig.title,
  formattedDate,
  "title",
);

const description = await renderDescriptionTemplate({
  templatePath: fileConfig.descriptionTemplate,
  formattedDate,
});

const scheduledStartTime = zonedDateTimeToIso(
  targetDate,
  runtimeConfig.startTime,
  runtimeConfig.timeZone,
);

const scheduledEndTime = new Date(
  new Date(scheduledStartTime).getTime() +
    fileConfig.durationMinutes * 60_000,
).toISOString();

printConfiguration({
  targetDate,
  formattedDate,
  title,
  description,
  scheduledStartTime,
  scheduledEndTime,
});

if (runtimeConfig.dryRun) {
  console.log(
    "\nDry run complete. No external resources were changed.",
  );

  await writeGitHubSummary({
    status: "Dry run",
    targetDate,
    scheduledStartTime,
    title,
    broadcastId: "",
    youtubeUrl: "",
    duplicateFound: false,
    playlistUpdated: false,
    shortIoUpdated: false,
  });

  process.exit(0);
}

const youtube = createYouTubeClient();

let broadcast = await findExistingBroadcast(
  youtube,
  scheduledStartTime,
);

const duplicateFound = Boolean(broadcast);

if (broadcast) {
  console.log(
    `\nExisting broadcast found: ${broadcast.id} — ${
      broadcast.snippet?.title || "Untitled"
    }`,
  );
} else {
  broadcast = await createBroadcast(youtube, {
    title,
    description,
    scheduledStartTime,
    scheduledEndTime,
    privacyStatus: fileConfig.privacyStatus,
    madeForKids: fileConfig.madeForKids,
    contentDetails: fileConfig.contentDetails,
  });

  console.log(`\nCreated broadcast: ${broadcast.id}`);
}

if (!broadcast.id) {
  throw new Error(
    "YouTube did not return a broadcast ID.",
  );
}

if (runtimeConfig.reusableStreamId) {
  await ensureStreamBinding(
    youtube,
    broadcast,
    runtimeConfig.reusableStreamId,
  );
} else {
  console.log(
    "\nYOUTUBE_STREAM_ID is not configured; stream binding skipped.",
  );
}

let playlistUpdated = false;

if (fileConfig.playlist.enabled) {
  await ensureVideoInPlaylist(
    youtube,
    runtimeConfig.playlistId,
    broadcast.id,
  );

  playlistUpdated = true;
}

const youtubeUrl =
  `https://www.youtube.com/watch?v=${broadcast.id}`;

let shortIoUpdated = false;

if (runtimeConfig.updateShortIo) {
  await updateShortIoLink(youtubeUrl);
  shortIoUpdated = true;
} else {
  console.log("\nShort.io update disabled.");
}

console.log("\nCompleted successfully.");
console.log(`YouTube URL: ${youtubeUrl}`);

await writeGitHubOutputs({
  broadcastId: broadcast.id,
  youtubeUrl,
  targetDate,
  scheduledStartTime,
  duplicateFound,
  playlistUpdated,
  shortIoUpdated,
});

await writeGitHubSummary({
  status: duplicateFound
    ? "Existing broadcast reused"
    : "New broadcast created",
  targetDate,
  scheduledStartTime,
  title: broadcast.snippet?.title || title,
  broadcastId: broadcast.id,
  youtubeUrl,
  duplicateFound,
  playlistUpdated,
  shortIoUpdated,
});

async function loadBroadcastConfig(configFilePath) {
  const resolvedPath = path.resolve(
    process.cwd(),
    configFilePath,
  );

  let rawConfig;

  try {
    rawConfig = await readFile(resolvedPath, "utf8");
  } catch (error) {
    throw new Error(
      `Unable to read broadcast config at ${resolvedPath}: ${
        error instanceof Error
          ? error.message
          : String(error)
      }`,
    );
  }

  try {
    return JSON.parse(rawConfig);
  } catch (error) {
    throw new Error(
      `Invalid JSON in ${resolvedPath}: ${
        error instanceof Error
          ? error.message
          : String(error)
      }`,
    );
  }
}

function validateBroadcastConfig(config) {
  if (
    !config ||
    typeof config !== "object" ||
    Array.isArray(config)
  ) {
    throw new Error(
      "Broadcast configuration must be a JSON object.",
    );
  }

  if (
    !Number.isInteger(config.durationMinutes) ||
    config.durationMinutes <= 0
  ) {
    throw new Error(
      "durationMinutes must be a positive integer.",
    );
  }

  requireNonEmptyString(config.title, "title");

  requireNonEmptyString(
    config.descriptionTemplate,
    "descriptionTemplate",
  );

  requireNonEmptyString(
    config.privacyStatus,
    "privacyStatus",
  );

  const validPrivacyStatuses = new Set([
    "private",
    "unlisted",
    "public",
  ]);

  if (
    !validPrivacyStatuses.has(config.privacyStatus)
  ) {
    throw new Error(
      "privacyStatus must be private, unlisted, or public.",
    );
  }

  if (typeof config.madeForKids !== "boolean") {
    throw new Error(
      "madeForKids must be true or false.",
    );
  }

  if (
    !config.playlist ||
    typeof config.playlist !== "object" ||
    Array.isArray(config.playlist)
  ) {
    throw new Error(
      "playlist must be a JSON object.",
    );
  }

  if (typeof config.playlist.enabled !== "boolean") {
    throw new Error(
      "playlist.enabled must be true or false.",
    );
  }

  if (
    !config.contentDetails ||
    typeof config.contentDetails !== "object" ||
    Array.isArray(config.contentDetails)
  ) {
    throw new Error(
      "contentDetails must be a JSON object.",
    );
  }

  const contentDetailBooleanFields = [
    "enableAutoStart",
    "enableAutoStop",
    "enableDvr",
    "enableEmbed",
    "recordFromStart",
  ];

  for (const field of contentDetailBooleanFields) {
    if (
      typeof config.contentDetails[field] !==
      "boolean"
    ) {
      throw new Error(
        `contentDetails.${field} must be true or false.`,
      );
    }
  }

  if (
    !config.studioSettings ||
    typeof config.studioSettings !== "object" ||
    Array.isArray(config.studioSettings)
  ) {
    throw new Error(
      "studioSettings must be a JSON object.",
    );
  }

  if (
    !config.studioSettings.slowMode ||
    typeof config.studioSettings.slowMode !==
      "object"
  ) {
    throw new Error(
      "studioSettings.slowMode must be an object.",
    );
  }

  if (
    typeof config.studioSettings.slowMode.enabled !==
    "boolean"
  ) {
    throw new Error(
      "studioSettings.slowMode.enabled must be boolean.",
    );
  }

  if (
    !Number.isInteger(
      config.studioSettings.slowMode.delaySeconds,
    ) ||
    config.studioSettings.slowMode.delaySeconds < 0
  ) {
    throw new Error(
      "studioSettings.slowMode.delaySeconds must be a non-negative integer.",
    );
  }

  if (
    typeof config.studioSettings.liveReactions !==
    "boolean"
  ) {
    throw new Error(
      "studioSettings.liveReactions must be boolean.",
    );
  }

  requireNonEmptyString(
    config.studioSettings.liveChat,
    "studioSettings.liveChat",
  );

  if (
    typeof config.studioSettings.aiFeatures !==
    "boolean"
  ) {
    throw new Error(
      "studioSettings.aiFeatures must be boolean.",
    );
  }

  validateSupportedPlaceholders(
    config.title,
    "title",
  );
}

function validateRuntimeConfig() {
  requireNonEmptyString(
    runtimeConfig.timeZone,
    "YOUTUBE_TIME_ZONE",
  );

  requireNonEmptyString(
    runtimeConfig.startTime,
    "YOUTUBE_START_TIME",
  );

  if (
    !/^\d{2}:\d{2}$/.test(runtimeConfig.startTime)
  ) {
    throw new Error(
      "YOUTUBE_START_TIME must use HH:mm format.",
    );
  }

  const [hour, minute] =
    runtimeConfig.startTime.split(":").map(Number);

  if (
    hour < 0 ||
    hour > 23 ||
    minute < 0 ||
    minute > 59
  ) {
    throw new Error(
      `Invalid YOUTUBE_START_TIME: ${runtimeConfig.startTime}`,
    );
  }

  try {
    new Intl.DateTimeFormat("en-US", {
      timeZone: runtimeConfig.timeZone,
    }).format(new Date());
  } catch {
    throw new Error(
      `Invalid YOUTUBE_TIME_ZONE: ${runtimeConfig.timeZone}`,
    );
  }

  if (
    fileConfig.playlist.enabled &&
    !runtimeConfig.playlistId
  ) {
    throw new Error(
      "YOUTUBE_PLAYLIST_ID is required when playlist.enabled is true.",
    );
  }
}

function validateEnvironment() {
  if (runtimeConfig.dryRun) {
    return;
  }

  const required = [
    "GOOGLE_CLIENT_ID",
    "GOOGLE_CLIENT_SECRET",
    "GOOGLE_REFRESH_TOKEN",
  ];

  if (runtimeConfig.updateShortIo) {
    required.push(
      "SHORT_IO_API_KEY",
      "SHORT_IO_LINK_ID",
    );
  }

  const missing = required.filter(
    (name) => !process.env[name]?.trim(),
  );

  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missing.join(", ")}`,
    );
  }
}

function requireNonEmptyString(value, fieldName) {
  if (
    typeof value !== "string" ||
    value.trim() === ""
  ) {
    throw new Error(
      `${fieldName} must be a non-empty string.`,
    );
  }
}

function validateSupportedPlaceholders(
  template,
  templateName,
) {
  const placeholders = [
    ...template.matchAll(/\{\{([^{}]+)\}\}/g),
  ].map((match) => match[1].trim());

  const unsupported = placeholders.filter(
    (placeholder) => placeholder !== "date",
  );

  if (unsupported.length > 0) {
    throw new Error(
      `Unsupported placeholders in ${templateName}: ${[
        ...new Set(unsupported),
      ].join(", ")}. Only {{date}} is supported.`,
    );
  }
}

function renderTemplateValue(
  template,
  formattedDate,
  templateName,
) {
  validateSupportedPlaceholders(
    template,
    templateName,
  );

  return template
    .replaceAll("{{date}}", formattedDate)
    .trim();
}

async function renderDescriptionTemplate({
  templatePath,
  formattedDate,
}) {
  const resolvedPath = path.resolve(
    process.cwd(),
    templatePath,
  );

  let template;

  try {
    template = await readFile(resolvedPath, "utf8");
  } catch (error) {
    throw new Error(
      `Unable to read description template at ${resolvedPath}: ${
        error instanceof Error
          ? error.message
          : String(error)
      }`,
    );
  }

  validateSupportedPlaceholders(
    template,
    "description template",
  );

  return template
    .replaceAll("{{date}}", formattedDate)
    .trim();
}

function createYouTubeClient() {
  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
  );

  oauth2Client.setCredentials({
    refresh_token:
      process.env.GOOGLE_REFRESH_TOKEN,
  });

  return google.youtube({
    version: "v3",
    auth: oauth2Client,
  });
}

async function findExistingBroadcast(
  youtube,
  expectedStartTime,
) {
  let pageToken;

  do {
    const response =
      await youtube.liveBroadcasts.list({
        part: [
          "id",
          "snippet",
          "status",
          "contentDetails",
        ],
        broadcastStatus: "upcoming",
        broadcastType: "all",
        maxResults: 50,
        pageToken,
      });

    const broadcasts = response.data.items || [];

    const match = broadcasts.find((item) => {
      const existingStart =
        item.snippet?.scheduledStartTime;

      if (!existingStart) {
        return false;
      }

      return (
        new Date(existingStart).getTime() ===
        new Date(expectedStartTime).getTime()
      );
    });

    if (match) {
      return match;
    }

    pageToken = response.data.nextPageToken;
  } while (pageToken);

  return null;
}

async function createBroadcast(
  youtube,
  {
    title,
    description,
    scheduledStartTime,
    scheduledEndTime,
    privacyStatus,
    madeForKids,
    contentDetails,
  },
) {
  console.log("\nCreating YouTube broadcast...");

  const response =
    await youtube.liveBroadcasts.insert({
      part: [
        "id",
        "snippet",
        "status",
        "contentDetails",
      ],
      requestBody: {
        snippet: {
          title,
          description,
          scheduledStartTime,
          scheduledEndTime,
        },
        status: {
          privacyStatus,
          selfDeclaredMadeForKids: madeForKids,
        },
        contentDetails,
      },
    });

  if (!response.data.id) {
    throw new Error(
      "YouTube created no usable broadcast or returned no ID.",
    );
  }

  return response.data;
}

async function ensureStreamBinding(
  youtube,
  broadcast,
  streamId,
) {
  if (
    broadcast.contentDetails?.boundStreamId ===
    streamId
  ) {
    console.log(
      `\nBroadcast is already bound to stream ${streamId}.`,
    );
    return;
  }

  console.log(
    `\nBinding broadcast to reusable stream ${streamId}...`,
  );

  await youtube.liveBroadcasts.bind({
    part: [
      "id",
      "snippet",
      "contentDetails",
      "status",
    ],
    id: broadcast.id,
    streamId,
  });

  console.log(
    "Broadcast successfully bound to reusable stream.",
  );
}

async function ensureVideoInPlaylist(
  youtube,
  playlistId,
  videoId,
) {
  const alreadyPresent = await isVideoInPlaylist(
    youtube,
    playlistId,
    videoId,
  );

  if (alreadyPresent) {
    console.log(
      `\nVideo ${videoId} is already in playlist ${playlistId}.`,
    );
    return;
  }

  console.log(
    `\nAdding video ${videoId} to playlist ${playlistId}...`,
  );

  await youtube.playlistItems.insert({
    part: ["snippet"],
    requestBody: {
      snippet: {
        playlistId,
        resourceId: {
          kind: "youtube#video",
          videoId,
        },
      },
    },
  });

  console.log(
    "Broadcast added to the configured playlist.",
  );
}

async function isVideoInPlaylist(
  youtube,
  playlistId,
  videoId,
) {
  let pageToken;

  do {
    const response =
      await youtube.playlistItems.list({
        part: ["snippet"],
        playlistId,
        videoId,
        maxResults: 50,
        pageToken,
      });

    const found = (
      response.data.items || []
    ).some(
      (item) =>
        item.snippet?.resourceId?.videoId ===
        videoId,
    );

    if (found) {
      return true;
    }

    pageToken = response.data.nextPageToken;
  } while (pageToken);

  return false;
}

async function updateShortIoLink(youtubeUrl) {
  if (!runtimeConfig.shortIoLinkId) {
    throw new Error(
      "SHORT_IO_LINK_ID is required when UPDATE_SHORT_IO is true.",
    );
  }

  console.log(
    `\nUpdating Short.io destination to ${youtubeUrl}...`,
  );

  const response = await fetch(
    `https://api.short.io/links/${encodeURIComponent(
      runtimeConfig.shortIoLinkId,
    )}`,
    {
      method: "POST",
      headers: {
        Authorization:
          process.env.SHORT_IO_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        originalURL: youtubeUrl,
      }),
    },
  );

  const responseText = await response.text();

  if (!response.ok) {
    throw new Error(
      `Short.io update failed with HTTP ${response.status}: ${responseText}`,
    );
  }

  console.log(
    "Short.io destination updated successfully.",
  );
}

function resolveTargetDate(input, timeZone) {
  if (input) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input)) {
      throw new Error(
        `TARGET_DATE must use YYYY-MM-DD format; received "${input}".`,
      );
    }

    const [year, month, day] =
      input.split("-").map(Number);

    const validationDate = new Date(
      Date.UTC(year, month - 1, day),
    );

    if (
      validationDate.getUTCFullYear() !== year ||
      validationDate.getUTCMonth() !==
        month - 1 ||
      validationDate.getUTCDate() !== day
    ) {
      throw new Error(
        `TARGET_DATE is not a valid date: ${input}`,
      );
    }

    return input;
  }

  const todayParts = getDatePartsInTimeZone(
    new Date(),
    timeZone,
  );

  const todayUtc = new Date(
    Date.UTC(
      todayParts.year,
      todayParts.month - 1,
      todayParts.day,
    ),
  );

  // Always select the next Sunday.
  // When run on Sunday, this chooses Sunday one week later.
  const daysUntilSunday =
    7 - todayUtc.getUTCDay();

  const target = new Date(
    todayUtc.getTime() +
      daysUntilSunday * 86_400_000,
  );

  return [
    target.getUTCFullYear(),
    String(
      target.getUTCMonth() + 1,
    ).padStart(2, "0"),
    String(target.getUTCDate()).padStart(
      2,
      "0",
    ),
  ].join("-");
}

function zonedDateTimeToIso(
  date,
  time,
  timeZone,
) {
  const [year, month, day] =
    date.split("-").map(Number);

  const [hour, minute] =
    time.split(":").map(Number);

  let candidate = new Date(
    Date.UTC(
      year,
      month - 1,
      day,
      hour,
      minute,
    ),
  );

  for (
    let attempt = 0;
    attempt < 3;
    attempt += 1
  ) {
    const parts =
      getDateTimePartsInTimeZone(
        candidate,
        timeZone,
      );

    const representedAsUtc = Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour,
      parts.minute,
    );

    const desiredAsUtc = Date.UTC(
      year,
      month - 1,
      day,
      hour,
      minute,
    );

    const difference =
      desiredAsUtc - representedAsUtc;

    if (difference === 0) {
      break;
    }

    candidate = new Date(
      candidate.getTime() + difference,
    );
  }

  const finalParts =
    getDateTimePartsInTimeZone(
      candidate,
      timeZone,
    );

  const exact =
    finalParts.year === year &&
    finalParts.month === month &&
    finalParts.day === day &&
    finalParts.hour === hour &&
    finalParts.minute === minute;

  if (!exact) {
    throw new Error(
      `Could not resolve ${date} ${time} in timezone ${timeZone}.`,
    );
  }

  return candidate.toISOString();
}

function getDatePartsInTimeZone(
  date,
  timeZone,
) {
  const formatter =
    new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });

  return partsToObject(
    formatter.formatToParts(date),
  );
}

function getDateTimePartsInTimeZone(
  date,
  timeZone,
) {
  const formatter =
    new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });

  return partsToObject(
    formatter.formatToParts(date),
  );
}

function partsToObject(parts) {
  return Object.fromEntries(
    parts
      .filter(
        (part) => part.type !== "literal",
      )
      .map((part) => [
        part.type,
        Number(part.value),
      ]),
  );
}

function formatDisplayDate(date, timeZone) {
  const [year, month, day] =
    date.split("-").map(Number);

  // Noon UTC avoids accidental date-boundary changes
  // when the value is formatted.
  const stableDate = new Date(
    Date.UTC(year, month - 1, day, 12),
  );

  return new Intl.DateTimeFormat("id-ID", {
    timeZone,
    day: "2-digit",
    month: "long",
    year: "numeric",
  }).format(stableDate);
}

function parseBoolean(value, defaultValue) {
  if (
    value === undefined ||
    value === ""
  ) {
    return defaultValue;
  }

  const normalized = String(value)
    .trim()
    .toLowerCase();

  if (
    ["true", "1", "yes", "on"].includes(
      normalized,
    )
  ) {
    return true;
  }

  if (
    ["false", "0", "no", "off"].includes(
      normalized,
    )
  ) {
    return false;
  }

  throw new Error(
    `Invalid boolean value: ${value}`,
  );
}

function printConfiguration({
  targetDate,
  formattedDate,
  title,
  description,
  scheduledStartTime,
  scheduledEndTime,
}) {
  console.log("Configuration:");
  console.log(`  Config file:       ${configPath}`);
  console.log(`  Target date:       ${targetDate}`);
  console.log(`  Display date:      ${formattedDate}`);
  console.log(`  Time zone:         ${runtimeConfig.timeZone}`);
  console.log(`  Start time:        ${runtimeConfig.startTime}`);
  console.log(`  Scheduled start:   ${scheduledStartTime}`);
  console.log(`  Scheduled end:     ${scheduledEndTime}`);
  console.log(`  Title:             ${title}`);
  console.log(`  Privacy:           ${fileConfig.privacyStatus}`);
  console.log(`  Made for kids:     ${fileConfig.madeForKids}`);
  console.log(
    `  Auto start:        ${fileConfig.contentDetails.enableAutoStart}`,
  );
  console.log(
    `  Auto stop:         ${fileConfig.contentDetails.enableAutoStop}`,
  );
  console.log(
    `  DVR:               ${fileConfig.contentDetails.enableDvr}`,
  );
  console.log(
    `  Embed:             ${fileConfig.contentDetails.enableEmbed}`,
  );
  console.log(
    `  Record from start: ${fileConfig.contentDetails.recordFromStart}`,
  );
  console.log(
    `  Playlist:          ${
      fileConfig.playlist.enabled
        ? runtimeConfig.playlistId
        : "disabled"
    }`,
  );
  console.log(
    `  Dry run:           ${runtimeConfig.dryRun}`,
  );
  console.log(
    `  Update Short.io:   ${runtimeConfig.updateShortIo}`,
  );
  console.log(
    `  Reusable stream:   ${
      runtimeConfig.reusableStreamId
        ? "configured"
        : "not configured"
    }`,
  );

  console.log("\nRendered description:");
  console.log("---------------------");
  console.log(description);
  console.log("---------------------");

  console.log(
    "\nManual YouTube Studio settings:",
  );
  console.log(
    `  Slow mode:         ${
      fileConfig.studioSettings.slowMode.enabled
        ? `${fileConfig.studioSettings.slowMode.delaySeconds}s`
        : "disabled"
    }`,
  );
  console.log(
    `  Live reactions:    ${
      fileConfig.studioSettings.liveReactions
        ? "enabled"
        : "disabled"
    }`,
  );
  console.log(
    `  Live chat:         ${fileConfig.studioSettings.liveChat}`,
  );
  console.log(
    `  AI features:       ${
      fileConfig.studioSettings.aiFeatures
        ? "enabled"
        : "disabled"
    }`,
  );
}

async function writeGitHubOutputs(values) {
  if (!process.env.GITHUB_OUTPUT) {
    return;
  }

  const lines = Object.entries(values)
    .map(
      ([key, value]) =>
        `${key}=${String(value)}`,
    )
    .join("\n");

  await appendFile(
    process.env.GITHUB_OUTPUT,
    `${lines}\n`,
  );
}

async function writeGitHubSummary({
  status,
  targetDate,
  scheduledStartTime,
  title,
  broadcastId,
  youtubeUrl,
  duplicateFound,
  playlistUpdated,
  shortIoUpdated,
}) {
  if (!process.env.GITHUB_STEP_SUMMARY) {
    return;
  }

  const rows = [
    ["Result", status],
    ["Target date", targetDate],
    ["Scheduled start", scheduledStartTime],
    ["Title", title],
    [
      "Broadcast ID",
      broadcastId || "Not created",
    ],
    [
      "YouTube URL",
      youtubeUrl
        ? `[Open broadcast](${youtubeUrl})`
        : "Not created",
    ],
    [
      "Existing broadcast found",
      String(duplicateFound),
    ],
    [
      "Playlist processed",
      String(playlistUpdated),
    ],
    [
      "Short.io updated",
      String(shortIoUpdated),
    ],
  ];

  const summary = [
    "## Weekly YouTube Broadcast",
    "",
    "| Field | Value |",
    "|---|---|",
    ...rows.map(
      ([key, value]) =>
        `| ${escapeMarkdown(key)} | ${escapeMarkdown(value)} |`,
    ),
    "",
    "## Manual YouTube Studio verification",
    "",
    "These settings are recorded in the repository but are not sent through the documented API:",
    "",
    `- Slow mode: ${
      fileConfig.studioSettings.slowMode.enabled
        ? `${fileConfig.studioSettings.slowMode.delaySeconds} seconds`
        : "Disabled"
    }`,
    `- Live reactions: ${
      fileConfig.studioSettings.liveReactions
        ? "Enabled"
        : "Disabled"
    }`,
    `- Live chat: ${fileConfig.studioSettings.liveChat}`,
    `- AI features: ${
      fileConfig.studioSettings.aiFeatures
        ? "Enabled"
        : "Disabled"
    }`,
    "",
  ].join("\n");

  await appendFile(
    process.env.GITHUB_STEP_SUMMARY,
    summary,
  );
}

function escapeMarkdown(value) {
  return String(value).replaceAll(
    "|",
    "\\|",
  );
}

