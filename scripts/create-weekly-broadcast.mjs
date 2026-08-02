import { appendFile, readFile } from "node:fs/promises";
import path from "node:path";
import { google } from "googleapis";

const CONFIG_PATH =
  process.env.YOUTUBE_BROADCAST_CONFIG ||
  "config/youtube-broadcasts.json";

const config = await loadJsonFile(CONFIG_PATH);

const runtime = {
  timeZone: process.env.YOUTUBE_TIME_ZONE || "Asia/Tokyo",
  playlistId: process.env.YOUTUBE_PLAYLIST_ID?.trim() || "",
  selectedProfile:
    process.env.SELECTED_PROFILE?.trim() || "all",
  targetDateInput:
    process.env.TARGET_DATE?.trim() || "",
  dryRun: parseBoolean(process.env.DRY_RUN, false),
  updateShortIo: parseBoolean(
    process.env.UPDATE_SHORT_IO,
    true,
  ),
  mode: process.env.PROCESS_MODE?.trim() || "full",
};

validateConfig(config);
validateRuntime(runtime);

const profiles = selectProfiles(
  config.broadcasts,
  runtime.selectedProfile,
);

const targetDate = resolveTargetDate(
  runtime.targetDateInput,
  runtime.timeZone,
);

const formattedDate = formatDisplayDate(targetDate);

const youtube = runtime.dryRun
  ? null
  : createYouTubeClient();

const results = [];

for (const profile of profiles) {
  const result = await processProfile({
    youtube,
    profile,
    targetDate,
    formattedDate,
  });

  results.push(result);
}

const validModes = new Set([
  "full",
  "create-only",
  "shortio-only",
]);

if (!validModes.has(runtime.mode)) {
  throw new Error(
    `PROCESS_MODE must be full, create-only, or shortio-only; ` +
      `received "${runtime.mode}".`,
  );
}

await writeGitHubOutputs(results);
await writeGitHubSummary(results);

console.log("\nAll selected broadcast profiles completed.");

/**
 * Processes one configured broadcast profile.
 */
async function processProfile({
  youtube,
  profile,
  targetDate,
  formattedDate,
}) {
  console.log(`\n${"=".repeat(64)}`);
  console.log(`Processing profile: ${profile.id}`);
  console.log("=".repeat(64));

  const startTime = readEnvironmentVariable(
    profile.startTimeVariable,
    {
      required: true,
      description: `${profile.id} start time`,
    },
  );

  validateTime(startTime, profile.startTimeVariable);

  const streamId = readEnvironmentVariable(
    profile.streamIdVariable,
  );

  const shortIoLinkId = readEnvironmentVariable(
    profile.shortIoLinkIdVariable,
    {
      required:
        runtime.updateShortIo && !runtime.dryRun,
      description: `${profile.id} Short.io link ID`,
    },
  );

  const title = renderTemplate(
    profile.title,
    formattedDate,
    `${profile.id}.title`,
  );

  const description = await renderDescriptionTemplate({
    templatePath: profile.descriptionTemplate,
    formattedDate,
    profileId: profile.id,
  });

  const scheduledStartTime = zonedDateTimeToIso(
    targetDate,
    startTime,
    runtime.timeZone,
  );

  const scheduledEndTime = new Date(
    new Date(scheduledStartTime).getTime() +
      profile.durationMinutes * 60_000,
  ).toISOString();

  printProfileConfiguration({
    profile,
    targetDate,
    formattedDate,
    startTime,
    scheduledStartTime,
    scheduledEndTime,
    title,
    description,
    streamId,
    shortIoLinkId,
  });

  if (runtime.dryRun) {
    console.log(
      "\nDry run complete. No YouTube or Short.io resources were changed.",
    );

    return {
      profileId: profile.id,
      status: "Dry run",
      targetDate,
      scheduledStartTime,
      title,
      broadcastId: "",
      youtubeUrl: "",
      existingBroadcast: false,
      streamBound: false,
      playlistProcessed: false,
      shortIoUpdated: false,
      studioSettings: profile.studioSettings,
    };
  }

  let broadcast = await findExistingBroadcast({
    youtube,
    profile,
    expectedStartTime: scheduledStartTime,
  });

  const existingBroadcast = Boolean(broadcast);

  if (broadcast) {
    console.log(
      `\nExisting broadcast found for profile ${profile.id}.`,
    );
  } else if (runtime.mode === "shortio-only") {
    throw new Error(
      `No existing upcoming broadcast was found for profile ` +
        `${profile.id} at ${scheduledStartTime}. ` +
        `The shortio-only mode will not create a broadcast.`,
    );
  } else {
    broadcast = await createBroadcast({
      youtube,
      profile,
      title,
      description,
      scheduledStartTime,
      scheduledEndTime,
    });

    console.log(
      `\nCreated a new broadcast for profile ${profile.id}.`,
    );
  }

  if (!broadcast?.id) {
    throw new Error(
      `YouTube did not return a broadcast ID for profile ${profile.id}.`,
    );
  }

  let streamBound = false;

  if (runtime.mode !== "shortio-only") {
    if (streamId) {
      streamBound = await ensureStreamBinding({
        youtube,
        broadcast,
        streamId,
      });
    } else {
      console.log(
        "\nNo stream ID is configured; stream binding skipped.",
      );
    }
  }

  let playlistProcessed = false;

  if (
    runtime.mode !== "shortio-only" &&
    profile.playlist.enabled
  ) {
    if (!runtime.playlistId) {
      throw new Error(
        `YOUTUBE_PLAYLIST_ID is required because playlist ` +
          `integration is enabled for profile ${profile.id}.`,
      );
    }

    await ensureVideoInPlaylist({
      youtube,
      playlistId: runtime.playlistId,
      videoId: broadcast.id,
    });

    playlistProcessed = true;
  } else {
    console.log("\nPlaylist integration disabled.");
  }

  const youtubeUrl =
    `https://www.youtube.com/watch?v=${broadcast.id}`;

  let shortIoUpdated = false;

  const shouldUpdateShortIo =
    runtime.mode === "shortio-only" ||
    (
      runtime.mode === "full" &&
      runtime.updateShortIo
    );

  if (shouldUpdateShortIo) {
    await updateShortIoLink({
      linkId: shortIoLinkId,
      destinationUrl: youtubeUrl,
      profileId: profile.id,
    });

    shortIoUpdated = true;
  } else {
    console.log("\nShort.io update skipped.");
  }

  console.log(`\nProfile completed: ${profile.id}`);

  return {
    profileId: profile.id,
    status: existingBroadcast
      ? "Existing broadcast reused"
      : "New broadcast created",
    targetDate,
    scheduledStartTime,
    title: broadcast.snippet?.title || title,

    // Used internally only. Do not print or write to summaries.
    broadcastId: broadcast.id,
    youtubeUrl,

    existingBroadcast,
    streamBound,
    playlistProcessed,
    shortIoUpdated,
    studioSettings: profile.studioSettings,
  };
}

/**
 * Loads and parses a JSON file relative to the repository root.
 */
async function loadJsonFile(filePath) {
  const resolvedPath = path.resolve(
    process.cwd(),
    filePath,
  );

  let raw;

  try {
    raw = await readFile(resolvedPath, "utf8");
  } catch (error) {
    throw new Error(
      `Unable to read ${resolvedPath}: ${formatError(
        error,
      )}`,
    );
  }

  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `Invalid JSON in ${resolvedPath}: ${formatError(
        error,
      )}`,
    );
  }
}

/**
 * Validates the root configuration and every profile.
 */
function validateConfig(value) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    throw new Error(
      "The broadcast configuration must be a JSON object.",
    );
  }

  if (
    !Array.isArray(value.broadcasts) ||
    value.broadcasts.length === 0
  ) {
    throw new Error(
      "The configuration must contain a non-empty broadcasts array.",
    );
  }

  const profileIds = new Set();

  for (const profile of value.broadcasts) {
    validateProfile(profile);

    if (profileIds.has(profile.id)) {
      throw new Error(
        `Duplicate broadcast profile ID: ${profile.id}`,
      );
    }

    profileIds.add(profile.id);
  }
}

/**
 * Validates one broadcast profile.
 */
function validateProfile(profile) {
  if (
    !profile ||
    typeof profile !== "object" ||
    Array.isArray(profile)
  ) {
    throw new Error(
      "Each broadcast profile must be a JSON object.",
    );
  }

  requireNonEmptyString(profile.id, "profile.id");

  if (typeof profile.enabled !== "boolean") {
    throw new Error(
      `${profile.id}.enabled must be true or false.`,
    );
  }

  if (
    !Number.isInteger(profile.durationMinutes) ||
    profile.durationMinutes <= 0
  ) {
    throw new Error(
      `${profile.id}.durationMinutes must be a positive integer.`,
    );
  }

  requireNonEmptyString(
    profile.title,
    `${profile.id}.title`,
  );

  requireNonEmptyString(
    profile.descriptionTemplate,
    `${profile.id}.descriptionTemplate`,
  );

  requireNonEmptyString(
    profile.startTimeVariable,
    `${profile.id}.startTimeVariable`,
  );

  validateOptionalString(
    profile.streamIdVariable,
    `${profile.id}.streamIdVariable`,
  );

  requireNonEmptyString(
    profile.shortIoLinkIdVariable,
    `${profile.id}.shortIoLinkIdVariable`,
  );

  const validPrivacyStatuses = new Set([
    "private",
    "unlisted",
    "public",
  ]);

  if (
    !validPrivacyStatuses.has(
      profile.privacyStatus,
    )
  ) {
    throw new Error(
      `${profile.id}.privacyStatus must be ` +
        "private, unlisted, or public.",
    );
  }

  if (typeof profile.madeForKids !== "boolean") {
    throw new Error(
      `${profile.id}.madeForKids must be true or false.`,
    );
  }

  if (
    !profile.playlist ||
    typeof profile.playlist !== "object" ||
    Array.isArray(profile.playlist)
  ) {
    throw new Error(
      `${profile.id}.playlist must be an object.`,
    );
  }

  if (typeof profile.playlist.enabled !== "boolean") {
    throw new Error(
      `${profile.id}.playlist.enabled must be boolean.`,
    );
  }

  validateContentDetails(
    profile.contentDetails,
    profile.id,
  );

  validateStudioSettings(
    profile.studioSettings,
    profile.id,
  );

  validateSupportedPlaceholders(
    profile.title,
    `${profile.id}.title`,
  );
}

function validateContentDetails(
  contentDetails,
  profileId,
) {
  if (
    !contentDetails ||
    typeof contentDetails !== "object" ||
    Array.isArray(contentDetails)
  ) {
    throw new Error(
      `${profileId}.contentDetails must be an object.`,
    );
  }

  const booleanFields = [
    "enableAutoStart",
    "enableAutoStop",
    "enableDvr",
    "enableEmbed",
    "recordFromStart",
  ];

  for (const field of booleanFields) {
    if (typeof contentDetails[field] !== "boolean") {
      throw new Error(
        `${profileId}.contentDetails.${field} ` +
          "must be true or false.",
      );
    }
  }
}

function validateStudioSettings(
  studioSettings,
  profileId,
) {
  if (
    !studioSettings ||
    typeof studioSettings !== "object" ||
    Array.isArray(studioSettings)
  ) {
    throw new Error(
      `${profileId}.studioSettings must be an object.`,
    );
  }

  const slowMode = studioSettings.slowMode;

  if (
    !slowMode ||
    typeof slowMode !== "object" ||
    Array.isArray(slowMode)
  ) {
    throw new Error(
      `${profileId}.studioSettings.slowMode ` +
        "must be an object.",
    );
  }

  if (typeof slowMode.enabled !== "boolean") {
    throw new Error(
      `${profileId}.studioSettings.slowMode.enabled ` +
        "must be boolean.",
    );
  }

  if (
    !Number.isInteger(slowMode.delaySeconds) ||
    slowMode.delaySeconds < 0
  ) {
    throw new Error(
      `${profileId}.studioSettings.slowMode.delaySeconds ` +
        "must be a non-negative integer.",
    );
  }

  if (
    typeof studioSettings.liveReactions !==
    "boolean"
  ) {
    throw new Error(
      `${profileId}.studioSettings.liveReactions ` +
        "must be boolean.",
    );
  }

  requireNonEmptyString(
    studioSettings.liveChat,
    `${profileId}.studioSettings.liveChat`,
  );

  if (
    typeof studioSettings.aiFeatures !==
    "boolean"
  ) {
    throw new Error(
      `${profileId}.studioSettings.aiFeatures ` +
        "must be boolean.",
    );
  }
}

/**
 * Validates runtime selection and timezone.
 */
function validateRuntime(value) {
  requireNonEmptyString(
    value.timeZone,
    "YOUTUBE_TIME_ZONE",
  );

  requireNonEmptyString(
    value.selectedProfile,
    "SELECTED_PROFILE",
  );

  try {
    new Intl.DateTimeFormat("en-US", {
      timeZone: value.timeZone,
    }).format(new Date());
  } catch {
    throw new Error(
      `Invalid YOUTUBE_TIME_ZONE: ${value.timeZone}`,
    );
  }

  if (
    !value.dryRun &&
    !process.env.GOOGLE_CLIENT_ID?.trim()
  ) {
    throw new Error(
      "GOOGLE_CLIENT_ID is required.",
    );
  }

  if (
    !value.dryRun &&
    !process.env.GOOGLE_CLIENT_SECRET?.trim()
  ) {
    throw new Error(
      "GOOGLE_CLIENT_SECRET is required.",
    );
  }

  if (
    !value.dryRun &&
    !process.env.GOOGLE_REFRESH_TOKEN?.trim()
  ) {
    throw new Error(
      "GOOGLE_REFRESH_TOKEN is required.",
    );
  }

  if (
    !value.dryRun &&
    value.updateShortIo &&
    !process.env.SHORT_IO_API_KEY?.trim()
  ) {
    throw new Error(
      "SHORT_IO_API_KEY is required when Short.io updates are enabled.",
    );
  }
}

/**
 * For "all", only enabled profiles run.
 *
 * When a specific profile ID is selected manually, that profile
 * may run even if enabled is false. This allows test profiles to
 * remain disabled for weekly scheduled runs.
 */
function selectProfiles(
  configuredProfiles,
  selectedProfile,
) {
  if (selectedProfile === "all") {
    const enabledProfiles =
      configuredProfiles.filter(
        (profile) => profile.enabled,
      );

    if (enabledProfiles.length === 0) {
      throw new Error(
        "No broadcast profiles are enabled.",
      );
    }

    return enabledProfiles;
  }

  const selected = configuredProfiles.find(
    (profile) => profile.id === selectedProfile,
  );

  if (!selected) {
    const available = configuredProfiles
      .map((profile) => profile.id)
      .join(", ");

    throw new Error(
      `Unknown profile "${selectedProfile}". ` +
        `Available profiles: ${available}`,
    );
  }

  return [selected];
}

/**
 * Authenticates with YouTube using the stored refresh token.
 */
function createYouTubeClient() {
  const auth = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
  );

  auth.setCredentials({
    refresh_token:
      process.env.GOOGLE_REFRESH_TOKEN,
  });

  return google.youtube({
    version: "v3",
    auth,
  });
}

/**
 * Finds an upcoming broadcast matching both:
 *
 * - the exact scheduled timestamp
 * - the static title prefix before {{date}}
 */
async function findExistingBroadcast({
  youtube,
  profile,
  expectedStartTime,
}) {
  let pageToken;

  const titlePrefix = getTitlePrefix(
    profile.title,
  );

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

    const match = (
      response.data.items || []
    ).find((item) => {
      const existingStart =
        item.snippet?.scheduledStartTime;

      const existingTitle =
        item.snippet?.title || "";

      if (!existingStart) {
        return false;
      }

      const sameTime =
        new Date(existingStart).getTime() ===
        new Date(expectedStartTime).getTime();

      const sameProfile =
        titlePrefix === "" ||
        existingTitle.startsWith(titlePrefix);

      return sameTime && sameProfile;
    });

    if (match) {
      return match;
    }

    pageToken = response.data.nextPageToken;
  } while (pageToken);

  return null;
}

function getTitlePrefix(titleTemplate) {
  const placeholderIndex =
    titleTemplate.indexOf("{{date}}");

  if (placeholderIndex < 0) {
    return titleTemplate.trim();
  }

  return titleTemplate
    .slice(0, placeholderIndex)
    .trim();
}

/**
 * Creates a scheduled broadcast.
 */
async function createBroadcast({
  youtube,
  profile,
  title,
  description,
  scheduledStartTime,
  scheduledEndTime,
}) {
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
          privacyStatus:
            profile.privacyStatus,
          selfDeclaredMadeForKids:
            profile.madeForKids,
        },
        contentDetails: {
          ...profile.contentDetails,
        },
      },
    });

  if (!response.data.id) {
    throw new Error(
      `YouTube returned no broadcast ID for ${profile.id}.`,
    );
  }

  return response.data;
}

/**
 * Binds the broadcast to its configured reusable stream.
 *
 * Returns true when the broadcast is or becomes bound.
 */
async function ensureStreamBinding({
  youtube,
  broadcast,
  streamId,
}) {
  if (
    broadcast.contentDetails?.boundStreamId ===
    streamId
  ) {
    console.log(
      `\nBroadcast is already bound to stream ${streamId}.`,
    );

    return true;
  }

  if (
    broadcast.contentDetails?.boundStreamId &&
    broadcast.contentDetails.boundStreamId !==
      streamId
  ) {
    console.log(
      "\nBroadcast is currently bound to another stream. " +
        `Rebinding to ${streamId}...`,
    );
  } else {
    console.log(
      `\nBinding broadcast to stream ${streamId}...`,
    );
  }

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
    "Broadcast successfully bound to stream.",
  );

  return true;
}

/**
 * Adds the broadcast to the configured playlist without duplicates.
 */
async function ensureVideoInPlaylist({
  youtube,
  playlistId,
  videoId,
}) {
  const exists = await isVideoInPlaylist({
    youtube,
    playlistId,
    videoId,
  });

  if (exists) {
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
    "Broadcast added to playlist.",
  );
}

async function isVideoInPlaylist({
  youtube,
  playlistId,
  videoId,
}) {
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

/**
 * Updates one Short.io link to the generated YouTube URL.
 */
async function updateShortIoLink({
  linkId,
  destinationUrl,
  profileId,
}) {
  console.log(
    `\nUpdating Short.io for ${profileId} to ${destinationUrl}...`,
  );

  const response = await fetch(
    `https://api.short.io/links/${encodeURIComponent(
      linkId,
    )}`,
    {
      method: "POST",
      headers: {
        Authorization:
          process.env.SHORT_IO_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        originalURL: destinationUrl,
      }),
    },
  );

  const responseText = await response.text();

  if (!response.ok) {
    throw new Error(
      `Short.io update failed for profile ${profileId} ` +
        `with HTTP ${response.status}: ${responseText}`,
    );
  }

  console.log(
    "Short.io destination updated successfully.",
  );
}

/**
 * Reads the environment variable named by a profile field.
 */
function readEnvironmentVariable(
  variableName,
  {
    required = false,
    description = variableName,
  } = {},
) {
  if (
    typeof variableName !== "string" ||
    variableName.trim() === ""
  ) {
    if (required) {
      throw new Error(
        `An environment variable name is required for ${description}.`,
      );
    }

    return "";
  }

  const value =
    process.env[variableName]?.trim() || "";

  if (required && !value) {
    throw new Error(
      `${variableName} is required for ${description}.`,
    );
  }

  return value;
}

/**
 * Loads and renders a description template.
 */
async function renderDescriptionTemplate({
  templatePath,
  formattedDate,
  profileId,
}) {
  const resolvedPath = path.resolve(
    process.cwd(),
    templatePath,
  );

  let template;

  try {
    template = await readFile(
      resolvedPath,
      "utf8",
    );
  } catch (error) {
    throw new Error(
      `Unable to read the description template for ` +
        `${profileId} at ${resolvedPath}: ${formatError(
          error,
        )}`,
    );
  }

  return renderTemplate(
    template,
    formattedDate,
    `${profileId}.descriptionTemplate`,
  );
}

/**
 * Supports only the {{date}} placeholder.
 */
function renderTemplate(
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
      `Unsupported placeholders in ${templateName}: ` +
        `${[...new Set(unsupported)].join(", ")}. ` +
        "Only {{date}} is supported.",
    );
  }
}

/**
 * Uses an explicit target date or calculates the next Sunday.
 *
 * Running on Sunday without TARGET_DATE selects the following Sunday.
 */
function resolveTargetDate(input, timeZone) {
  if (input) {
    validateIsoDate(input);
    return input;
  }

  const today = getDatePartsInTimeZone(
    new Date(),
    timeZone,
  );

  const localDateAsUtc = new Date(
    Date.UTC(
      today.year,
      today.month - 1,
      today.day,
    ),
  );

  const daysUntilSunday =
    7 - localDateAsUtc.getUTCDay();

  const target = new Date(
    localDateAsUtc.getTime() +
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

function validateIsoDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(
      `TARGET_DATE must use YYYY-MM-DD format; received "${value}".`,
    );
  }

  const [year, month, day] =
    value.split("-").map(Number);

  const candidate = new Date(
    Date.UTC(year, month - 1, day),
  );

  if (
    candidate.getUTCFullYear() !== year ||
    candidate.getUTCMonth() !== month - 1 ||
    candidate.getUTCDate() !== day
  ) {
    throw new Error(
      `TARGET_DATE is not valid: ${value}`,
    );
  }
}

/**
 * Converts a local date/time in an IANA timezone to UTC ISO.
 */
function zonedDateTimeToIso(
  date,
  time,
  timeZone,
) {
  validateTime(time, "start time");

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
    attempt < 4;
    attempt += 1
  ) {
    const represented =
      getDateTimePartsInTimeZone(
        candidate,
        timeZone,
      );

    const representedUtc = Date.UTC(
      represented.year,
      represented.month - 1,
      represented.day,
      represented.hour,
      represented.minute,
    );

    const desiredUtc = Date.UTC(
      year,
      month - 1,
      day,
      hour,
      minute,
    );

    const difference =
      desiredUtc - representedUtc;

    if (difference === 0) {
      break;
    }

    candidate = new Date(
      candidate.getTime() + difference,
    );
  }

  const finalValue =
    getDateTimePartsInTimeZone(
      candidate,
      timeZone,
    );

  const exact =
    finalValue.year === year &&
    finalValue.month === month &&
    finalValue.day === day &&
    finalValue.hour === hour &&
    finalValue.minute === minute;

  if (!exact) {
    throw new Error(
      `Could not resolve ${date} ${time} in timezone ${timeZone}.`,
    );
  }

  return candidate.toISOString();
}

function validateTime(value, fieldName) {
  if (!/^\d{2}:\d{2}$/.test(value)) {
    throw new Error(
      `${fieldName} must use HH:mm format; received "${value}".`,
    );
  }

  const [hour, minute] =
    value.split(":").map(Number);

  if (
    hour < 0 ||
    hour > 23 ||
    minute < 0 ||
    minute > 59
  ) {
    throw new Error(
      `Invalid ${fieldName}: ${value}`,
    );
  }
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

/**
 * Formats {{date}} as Indonesian dd LLLL yyyy.
 */
function formatDisplayDate(date) {
  const [year, month, day] =
    date.split("-").map(Number);

  const stableDate = new Date(
    Date.UTC(year, month - 1, day, 12),
  );

  return new Intl.DateTimeFormat("id-ID", {
    timeZone: "UTC",
    day: "2-digit",
    month: "long",
    year: "numeric",
  }).format(stableDate);
}

function parseBoolean(value, defaultValue) {
  if (
    value === undefined ||
    value === null ||
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

function requireNonEmptyString(
  value,
  fieldName,
) {
  if (
    typeof value !== "string" ||
    value.trim() === ""
  ) {
    throw new Error(
      `${fieldName} must be a non-empty string.`,
    );
  }
}

function validateOptionalString(
  value,
  fieldName,
) {
  if (
    value !== undefined &&
    (typeof value !== "string" ||
      value.trim() === "")
  ) {
    throw new Error(
      `${fieldName} must be omitted or a non-empty string.`,
    );
  }
}

function formatError(error) {
  return error instanceof Error
    ? error.message
    : String(error);
}

function printProfileConfiguration({
  profile,
  targetDate,
  formattedDate,
  startTime,
  scheduledStartTime,
  scheduledEndTime,
  title,
  description,
  streamId,
  shortIoLinkId,
}) {
  console.log("\nConfiguration:");
  console.log(`  Profile:           ${profile.id}`);
  console.log(`  Config file:       ${CONFIG_PATH}`);
  console.log(`  Target date:       ${targetDate}`);
  console.log(`  Display date:      ${formattedDate}`);
  console.log(`  Time zone:         ${runtime.timeZone}`);
  console.log(`  Start time:        ${startTime}`);
  console.log(`  Scheduled start:   ${scheduledStartTime}`);
  console.log(`  Scheduled end:     ${scheduledEndTime}`);
  console.log(`  Duration:          ${profile.durationMinutes} minutes`);
  console.log(`  Title:             ${title}`);
  console.log(`  Privacy:           ${profile.privacyStatus}`);
  console.log(`  Made for kids:     ${profile.madeForKids}`);
  console.log(
    `  Stream binding:    ${
      streamId ? "configured" : "not configured"
    }`,
  );
  console.log(
    `  Playlist:          ${
      profile.playlist.enabled
        ? runtime.playlistId
        : "disabled"
    }`,
  );
  console.log(
    `  Short.io link:     ${
      shortIoLinkId ? "configured" : "not configured"
    }`,
  );
  console.log(`  Dry run:           ${runtime.dryRun}`);
  console.log(
    `  Update Short.io:   ${runtime.updateShortIo}`,
  );

  console.log("\nYouTube API content settings:");
  console.log(
    `  Auto start:        ${profile.contentDetails.enableAutoStart}`,
  );
  console.log(
    `  Auto stop:         ${profile.contentDetails.enableAutoStop}`,
  );
  console.log(
    `  DVR:               ${profile.contentDetails.enableDvr}`,
  );
  console.log(
    `  Embed:             ${profile.contentDetails.enableEmbed}`,
  );
  console.log(
    `  Record from start: ${profile.contentDetails.recordFromStart}`,
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
      profile.studioSettings.slowMode.enabled
        ? `${profile.studioSettings.slowMode.delaySeconds}s`
        : "disabled"
    }`,
  );
  console.log(
    `  Live reactions:    ${
      profile.studioSettings.liveReactions
        ? "enabled"
        : "disabled"
    }`,
  );
  console.log(
    `  Live chat:         ${profile.studioSettings.liveChat}`,
  );
  console.log(
    `  AI features:       ${
      profile.studioSettings.aiFeatures
        ? "enabled"
        : "disabled"
    }`,
  );
}

/**
 * Writes compact outputs. For multiple profiles, values are JSON.
 */
async function writeGitHubOutputs(results) {
  if (!process.env.GITHUB_OUTPUT) {
    return;
  }

  const outputs = {
    result_count: results.length,
    processed_profiles: results
      .map((result) => result.profileId)
      .join(","),
  };

  const lines = Object.entries(outputs)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join("\n");

  await appendFile(
    process.env.GITHUB_OUTPUT,
    `${lines}\n`,
  );
}

/**
 * Creates one GitHub Actions summary section per profile.
 */
async function writeGitHubSummary(results) {
  if (!process.env.GITHUB_STEP_SUMMARY) {
    return;
  }

  const sections = [
    "# Weekly YouTube Broadcast Automation",
    "",
  ];

  for (const result of results) {
    sections.push(
      `## ${escapeMarkdown(result.profileId)}`,
      "",
      "| Field | Value |",
      "|---|---|",
      `| Result | ${escapeMarkdown(result.status)} |`,
      `| Target date | ${escapeMarkdown(result.targetDate)} |`,
      `| Scheduled start | ${escapeMarkdown(
        result.scheduledStartTime,
      )} |`,
      `| Title | ${escapeMarkdown(result.title)} |`,
      `| Existing broadcast reused | ${result.existingBroadcast} |`,
      `| Broadcast resolved | ${Boolean(result.broadcastId)} |`,
      `| Stream bound | ${result.streamBound} |`,
      `| Playlist processed | ${result.playlistProcessed} |`,
      `| Short.io updated | ${result.shortIoUpdated} |`,
      "",
      "### Manual YouTube Studio verification",
      "",
      `- Slow mode: ${
        result.studioSettings.slowMode.enabled
          ? `${result.studioSettings.slowMode.delaySeconds} seconds`
          : "Disabled"
      }`,
      `- Live reactions: ${
        result.studioSettings.liveReactions
          ? "Enabled"
          : "Disabled"
      }`,
      `- Live chat: ${escapeMarkdown(
        result.studioSettings.liveChat,
      )}`,
      `- AI features: ${
        result.studioSettings.aiFeatures
          ? "Enabled"
          : "Disabled"
      }`,
      "",
    );
  }

  await appendFile(
    process.env.GITHUB_STEP_SUMMARY,
    sections.join("\n"),
  );
}

function escapeMarkdown(value) {
  return String(value)
    .replaceAll("|", "\\|")
    .replaceAll("\n", "<br>");
}

