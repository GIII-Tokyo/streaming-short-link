import { appendFile, readFile } from "node:fs/promises";
import path from "node:path";
import { google } from "googleapis";

const CONFIG_PATH =
  process.env.YOUTUBE_BROADCAST_CONFIG ||
  "config/youtube-broadcasts.json";

const rootConfig = await loadJsonFile(CONFIG_PATH);

const runtime = {
  timeZone:
    process.env.YOUTUBE_TIME_ZONE?.trim() ||
    "Asia/Tokyo",

  playlistId:
    process.env.YOUTUBE_PLAYLIST_ID?.trim() ||
    "",

  selectedProfile:
    process.env.SELECTED_PROFILE?.trim() ||
    "all",

  targetDateInput:
    process.env.TARGET_DATE?.trim() ||
    "",

  processMode:
    process.env.PROCESS_MODE?.trim() ||
    "create-only",

  dryRun: parseBoolean(
    process.env.DRY_RUN,
    false,
  ),
};

validateRootConfig(rootConfig);
validateRuntime(runtime);

const selectedProfiles = selectProfiles(
  rootConfig.broadcasts,
  runtime.selectedProfile,
);

const targetDate = resolveTargetDate(
  runtime.targetDateInput,
  runtime.timeZone,
);

const formattedDate =
  formatIndonesianDate(targetDate);

const youtube = runtime.dryRun
  ? null
  : createYouTubeClient();

const results = [];

for (const profile of selectedProfiles) {
  const result = await processProfile({
    youtube,
    profile,
    targetDate,
    formattedDate,
  });

  results.push(result);
}

await writeGitHubOutputs(results);
await writeGitHubSummary(results);

console.log(
  "\nAll selected broadcast profiles completed.",
);

/**
 * Processes one broadcast profile.
 */
async function processProfile({
  youtube,
  profile,
  targetDate,
  formattedDate,
}) {
  console.log(`\n${"=".repeat(64)}`);
  console.log(`Processing profile: ${profile.id}`);
  console.log(`Mode: ${runtime.processMode}`);
  console.log("=".repeat(64));

  const startTime = readNamedEnvironmentVariable(
    profile.startTimeVariable,
    {
      required: true,
      description: `${profile.id} start time`,
    },
  );

  validateTime(
    startTime,
    profile.startTimeVariable,
  );

  const streamId = readNamedEnvironmentVariable(
    profile.streamIdVariable,
    {
      required: false,
      description: `${profile.id} stream ID`,
    },
  );

  const shortIoLinkId =
    readNamedEnvironmentVariable(
      profile.shortIoLinkIdVariable,
      {
        required:
          runtime.processMode === "publish" &&
          !runtime.dryRun,
        description:
          `${profile.id} Short.io link ID`,
      },
    );

  const title = renderTemplate({
    template: profile.title,
    formattedDate,
    templateName: `${profile.id}.title`,
  });

  const description =
    await renderDescriptionTemplate({
      templatePath:
        profile.descriptionTemplate,
      formattedDate,
      profileId: profile.id,
    });

  const scheduledStartTime =
    zonedDateTimeToIso({
      date: targetDate,
      time: startTime,
      timeZone: runtime.timeZone,
    });

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
    streamConfigured: Boolean(streamId),
    shortLinkConfigured:
      Boolean(shortIoLinkId),
  });

  if (runtime.dryRun) {
    console.log(
      "\nDry run complete. No external resources were changed.",
    );

    return {
      profileId: profile.id,
      mode: runtime.processMode,
      status: "Dry run",
      targetDate,
      scheduledStartTime,
      title,
      existingBroadcast: false,
      streamProcessed: false,
      playlistProcessed: false,
      published: false,
      shortIoUpdated: false,
      previousBroadcastDemoted: false,
      studioSettings:
        profile.studioSettings,
    };
  }

  switch (runtime.processMode) {
    case "create-only":
      return processCreateOnly({
        youtube,
        profile,
        targetDate,
        scheduledStartTime,
        scheduledEndTime,
        title,
        description,
        streamId,
      });

    case "publish":
      return processPublish({
        youtube,
        profile,
        targetDate,
        scheduledStartTime,
        title,
        startTime,
        shortIoLinkId,
      });

    default:
      throw new Error(
        `Unsupported process mode: ${runtime.processMode}`,
      );
  }
}

/**
 * Monday workflow:
 *
 * - find or create the upcoming broadcast
 * - bind the reusable stream
 * - keep it unlisted
 * - do not add it to the playlist
 * - do not update Short.io
 */
async function processCreateOnly({
  youtube,
  profile,
  targetDate,
  scheduledStartTime,
  scheduledEndTime,
  title,
  description,
  streamId,
}) {
  let broadcast =
    await findUpcomingBroadcast({
      youtube,
      profile,
      expectedStartTime:
        scheduledStartTime,
    });

  const existingBroadcast =
    Boolean(broadcast);

  if (broadcast) {
    console.log(
      "\nMatching upcoming broadcast found; creation skipped.",
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
      "\nPlaceholder broadcast created.",
    );
  }

  assertBroadcastId(
    broadcast,
    profile.id,
  );

  let streamProcessed = false;

  if (streamId) {
    await ensureStreamBinding({
      youtube,
      broadcast,
      streamId,
    });

    streamProcessed = true;
  } else {
    console.log(
      "\nNo reusable stream ID is configured; binding skipped.",
    );
  }

  // The configured initial status should normally
  // already be unlisted, but enforce it here.
  await setVideoPrivacy({
    youtube,
    videoId: broadcast.id,
    privacyStatus: "unlisted",
  });

  console.log(
    "\nCreate-only processing completed.",
  );

  return {
    profileId: profile.id,
    mode: runtime.processMode,
    status: existingBroadcast
      ? "Existing placeholder reused"
      : "New placeholder created",
    targetDate,
    scheduledStartTime,
    title:
      broadcast.snippet?.title ||
      title,
    existingBroadcast,
    streamProcessed,
    playlistProcessed: false,
    published: false,
    shortIoUpdated: false,
    previousBroadcastDemoted: false,
    studioSettings:
      profile.studioSettings,
  };
}

/**
 * Saturday workflow:
 *
 * - find the already-created upcoming broadcast
 * - add it to the unlisted archive playlist
 * - make it public
 * - update Short.io
 * - demote the previous week's broadcast to unlisted
 */
async function processPublish({
  youtube,
  profile,
  targetDate,
  scheduledStartTime,
  title,
  startTime,
  shortIoLinkId,
}) {
  const currentBroadcast =
    await findUpcomingBroadcast({
      youtube,
      profile,
      expectedStartTime:
        scheduledStartTime,
    });

  if (!currentBroadcast) {
    throw new Error(
      `No upcoming broadcast was found for profile ` +
        `${profile.id} at ${scheduledStartTime}. ` +
        "Publish mode will not create one.",
    );
  }

  assertBroadcastId(
    currentBroadcast,
    profile.id,
  );

  let playlistProcessed = false;

  if (profile.playlist.enabled) {
    if (!runtime.playlistId) {
      throw new Error(
        "YOUTUBE_PLAYLIST_ID is required " +
          `because playlist integration is enabled for ${profile.id}.`,
      );
    }

    await ensureBroadcastInPlaylist({
      youtube,
      playlistId:
        runtime.playlistId,
      broadcastId:
        currentBroadcast.id,
    });

    playlistProcessed = true;
  } else {
    console.log(
      "\nPlaylist integration is disabled for this profile.",
    );
  }

  // Publish the new broadcast before switching
  // the public Short.io destination.
  await setVideoPrivacy({
    youtube,
    videoId: currentBroadcast.id,
    privacyStatus: "public",
  });

  const currentUrl =
    `https://www.youtube.com/watch?v=${currentBroadcast.id}`;

  await updateShortIoLink({
    linkId: shortIoLinkId,
    destinationUrl: currentUrl,
    profileId: profile.id,
  });

  /*
   * Only after the new broadcast is public and
   * Short.io points to it do we demote the
   * previous week's broadcast.
   */
  const previousTargetDate =
    addDaysToIsoDate(
      targetDate,
      -7,
    );

  const previousScheduledStartTime =
    zonedDateTimeToIso({
      date: previousTargetDate,
      time: startTime,
      timeZone: runtime.timeZone,
    });

  const previousBroadcast =
    await findPreviousBroadcast({
      youtube,
      profile,
      expectedStartTime:
        previousScheduledStartTime,
    });

  let previousBroadcastDemoted = false;

  if (
    previousBroadcast?.id &&
    previousBroadcast.id !==
      currentBroadcast.id
  ) {
    await setVideoPrivacy({
      youtube,
      videoId:
        previousBroadcast.id,
      privacyStatus: "unlisted",
    });

    previousBroadcastDemoted = true;

    console.log(
      "\nPrevious week's broadcast changed to unlisted.",
    );
  } else {
    console.log(
      "\nNo matching previous-week broadcast was found; demotion skipped.",
    );
  }

  console.log(
    "\nPublish processing completed.",
  );

  return {
    profileId: profile.id,
    mode: runtime.processMode,
    status:
      "Broadcast published and short link updated",
    targetDate,
    scheduledStartTime,
    title:
      currentBroadcast.snippet?.title ||
      title,
    existingBroadcast: true,
    streamProcessed: false,
    playlistProcessed,
    published: true,
    shortIoUpdated: true,
    previousBroadcastDemoted,
    studioSettings:
      profile.studioSettings,
  };
}

/**
 * Loads JSON relative to the repository root.
 */
async function loadJsonFile(filePath) {
  const resolvedPath = path.resolve(
    process.cwd(),
    filePath,
  );

  let raw;

  try {
    raw = await readFile(
      resolvedPath,
      "utf8",
    );
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

function validateRootConfig(config) {
  if (
    !config ||
    typeof config !== "object" ||
    Array.isArray(config)
  ) {
    throw new Error(
      "The broadcast configuration must be a JSON object.",
    );
  }

  if (
    !Array.isArray(config.broadcasts) ||
    config.broadcasts.length === 0
  ) {
    throw new Error(
      "The configuration must contain a non-empty broadcasts array.",
    );
  }

  const seenIds = new Set();

  for (const profile of config.broadcasts) {
    validateProfile(profile);

    if (seenIds.has(profile.id)) {
      throw new Error(
        `Duplicate broadcast profile ID: ${profile.id}`,
      );
    }

    seenIds.add(profile.id);
  }
}

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

  requireNonEmptyString(
    profile.id,
    "profile.id",
  );

  if (typeof profile.enabled !== "boolean") {
    throw new Error(
      `${profile.id}.enabled must be boolean.`,
    );
  }

  if (
    !Number.isInteger(
      profile.durationMinutes,
    ) ||
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

  const validPrivacyStatuses =
    new Set([
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
      `${profile.id}.privacyStatus must be private, unlisted, or public.`,
    );
  }

  if (
    typeof profile.madeForKids !==
    "boolean"
  ) {
    throw new Error(
      `${profile.id}.madeForKids must be boolean.`,
    );
  }

  validatePlaylistConfig(
    profile.playlist,
    profile.id,
  );

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

function validatePlaylistConfig(
  playlist,
  profileId,
) {
  if (
    !playlist ||
    typeof playlist !== "object" ||
    Array.isArray(playlist)
  ) {
    throw new Error(
      `${profileId}.playlist must be an object.`,
    );
  }

  if (
    typeof playlist.enabled !==
    "boolean"
  ) {
    throw new Error(
      `${profileId}.playlist.enabled must be boolean.`,
    );
  }
}

function validateContentDetails(
  contentDetails,
  profileId,
) {
  if (
    !contentDetails ||
    typeof contentDetails !==
      "object" ||
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
    if (
      typeof contentDetails[field] !==
      "boolean"
    ) {
      throw new Error(
        `${profileId}.contentDetails.${field} must be boolean.`,
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
    typeof studioSettings !==
      "object" ||
    Array.isArray(studioSettings)
  ) {
    throw new Error(
      `${profileId}.studioSettings must be an object.`,
    );
  }

  const slowMode =
    studioSettings.slowMode;

  if (
    !slowMode ||
    typeof slowMode !== "object" ||
    Array.isArray(slowMode)
  ) {
    throw new Error(
      `${profileId}.studioSettings.slowMode must be an object.`,
    );
  }

  if (
    typeof slowMode.enabled !==
    "boolean"
  ) {
    throw new Error(
      `${profileId}.studioSettings.slowMode.enabled must be boolean.`,
    );
  }

  if (
    !Number.isInteger(
      slowMode.delaySeconds,
    ) ||
    slowMode.delaySeconds < 0
  ) {
    throw new Error(
      `${profileId}.studioSettings.slowMode.delaySeconds must be a non-negative integer.`,
    );
  }

  if (
    typeof studioSettings.liveReactions !==
    "boolean"
  ) {
    throw new Error(
      `${profileId}.studioSettings.liveReactions must be boolean.`,
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
      `${profileId}.studioSettings.aiFeatures must be boolean.`,
    );
  }
}

function validateRuntime(config) {
  requireNonEmptyString(
    config.timeZone,
    "YOUTUBE_TIME_ZONE",
  );

  requireNonEmptyString(
    config.selectedProfile,
    "SELECTED_PROFILE",
  );

  const validModes = new Set([
    "create-only",
    "publish",
  ]);

  if (
    !validModes.has(
      config.processMode,
    )
  ) {
    throw new Error(
      "PROCESS_MODE must be create-only or publish.",
    );
  }

  try {
    new Intl.DateTimeFormat(
      "en-US",
      {
        timeZone: config.timeZone,
      },
    ).format(new Date());
  } catch {
    throw new Error(
      `Invalid YOUTUBE_TIME_ZONE: ${config.timeZone}`,
    );
  }

  if (config.dryRun) {
    return;
  }

  const requiredCredentials = [
    "GOOGLE_CLIENT_ID",
    "GOOGLE_CLIENT_SECRET",
    "GOOGLE_REFRESH_TOKEN",
  ];

  if (
    config.processMode === "publish"
  ) {
    requiredCredentials.push(
      "SHORT_IO_API_KEY",
    );
  }

  const missing =
    requiredCredentials.filter(
      (name) =>
        !process.env[name]?.trim(),
    );

  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missing.join(
        ", ",
      )}`,
    );
  }
}

/**
 * "all" processes enabled profiles.
 *
 * Selecting a specific profile manually allows
 * processing it even when enabled=false.
 */
function selectProfiles(
  profiles,
  selectedProfile,
) {
  if (selectedProfile === "all") {
    const enabled =
      profiles.filter(
        (profile) => profile.enabled,
      );

    if (enabled.length === 0) {
      throw new Error(
        "No broadcast profiles are enabled.",
      );
    }

    return enabled;
  }

  const selected = profiles.find(
    (profile) =>
      profile.id === selectedProfile,
  );

  if (!selected) {
    throw new Error(
      `Unknown profile "${selectedProfile}". Available profiles: ` +
        profiles
          .map((profile) => profile.id)
          .join(", "),
    );
  }

  return [selected];
}

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
 * Finds a matching upcoming broadcast using:
 *
 * - exact scheduled timestamp
 * - title prefix before {{date}}
 */
async function findUpcomingBroadcast({
  youtube,
  profile,
  expectedStartTime,
}) {
  return findBroadcast({
    youtube,
    profile,
    expectedStartTime,
    statuses: ["upcoming"],
  });
}

/**
 * Searches statuses relevant to the prior week.
 *
 * A completed broadcast is normally returned under
 * completed, but "all" is used as a fallback.
 */
async function findPreviousBroadcast({
  youtube,
  profile,
  expectedStartTime,
}) {
  const completed = await findBroadcast({
    youtube,
    profile,
    expectedStartTime,
    statuses: ["completed"],
  });

  if (completed) {
    return completed;
  }

  return findBroadcast({
    youtube,
    profile,
    expectedStartTime,
    statuses: ["all"],
  });
}

async function findBroadcast({
  youtube,
  profile,
  expectedStartTime,
  statuses,
}) {
  const titlePrefix =
    getTitlePrefix(profile.title);

  for (const broadcastStatus of statuses) {
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
          broadcastStatus,
          broadcastType: "all",
          maxResults: 50,
          pageToken,
        });

      const match = (
        response.data.items || []
      ).find((item) => {
        const existingStart =
          item.snippet
            ?.scheduledStartTime;

        const existingTitle =
          item.snippet?.title ||
          "";

        if (!existingStart) {
          return false;
        }

        const sameTime =
          new Date(
            existingStart,
          ).getTime() ===
          new Date(
            expectedStartTime,
          ).getTime();

        const sameProfile =
          titlePrefix === "" ||
          existingTitle.startsWith(
            titlePrefix,
          );

        return (
          sameTime &&
          sameProfile
        );
      });

      if (match) {
        return match;
      }

      pageToken =
        response.data.nextPageToken;
    } while (pageToken);
  }

  return null;
}

function getTitlePrefix(
  titleTemplate,
) {
  const placeholderIndex =
    titleTemplate.indexOf(
      "{{date}}",
    );

  if (placeholderIndex < 0) {
    return titleTemplate.trim();
  }

  return titleTemplate
    .slice(0, placeholderIndex)
    .trim();
}

async function createBroadcast({
  youtube,
  profile,
  title,
  description,
  scheduledStartTime,
  scheduledEndTime,
}) {
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
          privacyStatus: "unlisted",
          selfDeclaredMadeForKids:
            profile.madeForKids,
        },
        contentDetails: {
          ...profile.contentDetails,
        },
      },
    });

  return response.data;
}

async function ensureStreamBinding({
  youtube,
  broadcast,
  streamId,
}) {
  if (
    broadcast.contentDetails
      ?.boundStreamId === streamId
  ) {
    console.log(
      "\nBroadcast is already bound to the configured reusable stream.",
    );
    return;
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
    "\nBroadcast bound to the configured reusable stream.",
  );
}

/**
 * Uses the videos API to change privacy.
 *
 * Existing status fields are preserved.
 */
async function setVideoPrivacy({
  youtube,
  videoId,
  privacyStatus,
}) {
  const response =
    await youtube.videos.list({
      part: ["status"],
      id: [videoId],
    });

  const video =
    response.data.items?.[0];

  if (!video) {
    throw new Error(
      "The corresponding YouTube video could not be found.",
    );
  }

  if (
    video.status?.privacyStatus ===
    privacyStatus
  ) {
    console.log(
      `\nVideo privacy is already ${privacyStatus}.`,
    );
    return;
  }

  await youtube.videos.update({
    part: ["status"],
    requestBody: {
      id: videoId,
      status: {
        ...video.status,
        privacyStatus,
      },
    },
  });

  console.log(
    `\nVideo privacy changed to ${privacyStatus}.`,
  );
}

async function ensureBroadcastInPlaylist({
  youtube,
  playlistId,
  broadcastId,
}) {
  const existingItem =
    await findPlaylistItem({
      youtube,
      playlistId,
      broadcastId,
    });

  if (existingItem) {
    console.log(
      "\nBroadcast is already present in the archive playlist.",
    );
    return;
  }

  await youtube.playlistItems.insert({
    part: ["snippet"],
    requestBody: {
      snippet: {
        playlistId,
        resourceId: {
          kind: "youtube#video",
          videoId: broadcastId,
        },
      },
    },
  });

  console.log(
    "\nBroadcast added to the archive playlist.",
  );
}

async function findPlaylistItem({
  youtube,
  playlistId,
  broadcastId,
}) {
  let pageToken;

  do {
    const response =
      await youtube.playlistItems.list({
        part: ["id", "snippet"],
        playlistId,
        videoId: broadcastId,
        maxResults: 50,
        pageToken,
      });

    const match = (
      response.data.items || []
    ).find(
      (item) =>
        item.snippet?.resourceId
          ?.videoId ===
        broadcastId,
    );

    if (match) {
      return match;
    }

    pageToken =
      response.data.nextPageToken;
  } while (pageToken);

  return null;
}

async function updateShortIoLink({
  linkId,
  destinationUrl,
  profileId,
}) {
  const response = await fetch(
    `https://api.short.io/links/${encodeURIComponent(
      linkId,
    )}`,
    {
      method: "POST",
      headers: {
        Authorization:
          process.env
            .SHORT_IO_API_KEY,
        "Content-Type":
          "application/json",
      },
      body: JSON.stringify({
        originalURL:
          destinationUrl,
      }),
    },
  );

  const responseText =
    await response.text();

  if (!response.ok) {
    throw new Error(
      `Short.io update failed for ${profileId} ` +
        `with HTTP ${response.status}: ${responseText}`,
    );
  }

  console.log(
    "\nShort.io destination updated.",
  );
}

function readNamedEnvironmentVariable(
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
    process.env[
      variableName
    ]?.trim() || "";

  if (required && !value) {
    throw new Error(
      `${variableName} is required for ${description}.`,
    );
  }

  return value;
}

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
        `${profileId}: ${formatError(error)}`,
    );
  }

  return renderTemplate({
    template,
    formattedDate,
    templateName:
      `${profileId}.descriptionTemplate`,
  });
}

function renderTemplate({
  template,
  formattedDate,
  templateName,
}) {
  validateSupportedPlaceholders(
    template,
    templateName,
  );

  return template
    .replaceAll(
      "{{date}}",
      formattedDate,
    )
    .trim();
}

function validateSupportedPlaceholders(
  template,
  templateName,
) {
  const placeholders = [
    ...template.matchAll(
      /\{\{([^{}]+)\}\}/g,
    ),
  ].map(
    (match) =>
      match[1].trim(),
  );

  const unsupported =
    placeholders.filter(
      (placeholder) =>
        placeholder !== "date",
    );

  if (unsupported.length > 0) {
    throw new Error(
      `Unsupported placeholders in ${templateName}: ` +
        `${[
          ...new Set(unsupported),
        ].join(", ")}. ` +
        "Only {{date}} is supported.",
    );
  }
}

function resolveTargetDate(
  input,
  timeZone,
) {
  if (input) {
    validateIsoDate(input);
    return input;
  }

  const today =
    getDatePartsInTimeZone(
      new Date(),
      timeZone,
    );

  const localDateAsUtc =
    new Date(
      Date.UTC(
        today.year,
        today.month - 1,
        today.day,
      ),
    );

  /*
   * Always select the next Sunday.
   * If run on Sunday, select the Sunday
   * one week later.
   */
  const daysUntilSunday =
    7 -
    localDateAsUtc.getUTCDay();

  return addDaysToIsoDate(
    formatUtcDate(
      localDateAsUtc,
    ),
    daysUntilSunday,
  );
}

function addDaysToIsoDate(
  isoDate,
  days,
) {
  validateIsoDate(isoDate);

  const [year, month, day] =
    isoDate
      .split("-")
      .map(Number);

  const value = new Date(
    Date.UTC(
      year,
      month - 1,
      day,
    ),
  );

  value.setUTCDate(
    value.getUTCDate() +
      days,
  );

  return formatUtcDate(value);
}

function formatUtcDate(date) {
  return [
    date.getUTCFullYear(),
    String(
      date.getUTCMonth() + 1,
    ).padStart(2, "0"),
    String(
      date.getUTCDate(),
    ).padStart(2, "0"),
  ].join("-");
}

function validateIsoDate(value) {
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(
      value,
    )
  ) {
    throw new Error(
      `TARGET_DATE must use YYYY-MM-DD format; received "${value}".`,
    );
  }

  const [year, month, day] =
    value
      .split("-")
      .map(Number);

  const candidate = new Date(
    Date.UTC(
      year,
      month - 1,
      day,
    ),
  );

  if (
    candidate.getUTCFullYear() !==
      year ||
    candidate.getUTCMonth() !==
      month - 1 ||
    candidate.getUTCDate() !==
      day
  ) {
    throw new Error(
      `Invalid date: ${value}`,
    );
  }
}

function zonedDateTimeToIso({
  date,
  time,
  timeZone,
}) {
  validateTime(
    time,
    "start time",
  );

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

    const representedUtc =
      Date.UTC(
        represented.year,
        represented.month - 1,
        represented.day,
        represented.hour,
        represented.minute,
      );

    const desiredUtc =
      Date.UTC(
        year,
        month - 1,
        day,
        hour,
        minute,
      );

    const difference =
      desiredUtc -
      representedUtc;

    if (difference === 0) {
      break;
    }

    candidate = new Date(
      candidate.getTime() +
        difference,
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

function validateTime(
  value,
  fieldName,
) {
  if (
    !/^\d{2}:\d{2}$/.test(
      value,
    )
  ) {
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
    new Intl.DateTimeFormat(
      "en-CA",
      {
        timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      },
    );

  return partsToObject(
    formatter.formatToParts(
      date,
    ),
  );
}

function getDateTimePartsInTimeZone(
  date,
  timeZone,
) {
  const formatter =
    new Intl.DateTimeFormat(
      "en-CA",
      {
        timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      },
    );

  return partsToObject(
    formatter.formatToParts(
      date,
    ),
  );
}

function partsToObject(parts) {
  return Object.fromEntries(
    parts
      .filter(
        (part) =>
          part.type !== "literal",
      )
      .map(
        (part) => [
          part.type,
          Number(part.value),
        ],
      ),
  );
}

/**
 * Indonesian dd LLLL yyyy.
 */
function formatIndonesianDate(
  isoDate,
) {
  const [year, month, day] =
    isoDate
      .split("-")
      .map(Number);

  const stableDate = new Date(
    Date.UTC(
      year,
      month - 1,
      day,
      12,
    ),
  );

  return new Intl.DateTimeFormat(
    "id-ID",
    {
      timeZone: "UTC",
      day: "2-digit",
      month: "long",
      year: "numeric",
    },
  ).format(stableDate);
}

function parseBoolean(
  value,
  defaultValue,
) {
  if (
    value === undefined ||
    value === null ||
    value === ""
  ) {
    return defaultValue;
  }

  const normalized =
    String(value)
      .trim()
      .toLowerCase();

  if (
    [
      "true",
      "1",
      "yes",
      "on",
    ].includes(normalized)
  ) {
    return true;
  }

  if (
    [
      "false",
      "0",
      "no",
      "off",
    ].includes(normalized)
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
    (
      typeof value !== "string" ||
      value.trim() === ""
    )
  ) {
    throw new Error(
      `${fieldName} must be omitted or a non-empty string.`,
    );
  }
}

function assertBroadcastId(
  broadcast,
  profileId,
) {
  if (!broadcast?.id) {
    throw new Error(
      `YouTube returned no broadcast ID for profile ${profileId}.`,
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
  streamConfigured,
  shortLinkConfigured,
}) {
  console.log("\nConfiguration:");
  console.log(
    `  Profile:           ${profile.id}`,
  );
  console.log(
    `  Config file:       ${CONFIG_PATH}`,
  );
  console.log(
    `  Mode:              ${runtime.processMode}`,
  );
  console.log(
    `  Target date:       ${targetDate}`,
  );
  console.log(
    `  Display date:      ${formattedDate}`,
  );
  console.log(
    `  Time zone:         ${runtime.timeZone}`,
  );
  console.log(
    `  Start time:        ${startTime}`,
  );
  console.log(
    `  Scheduled start:   ${scheduledStartTime}`,
  );
  console.log(
    `  Scheduled end:     ${scheduledEndTime}`,
  );
  console.log(
    `  Duration:          ${profile.durationMinutes} minutes`,
  );
  console.log(
    `  Title:             ${title}`,
  );
  console.log(
    `  Initial privacy:   unlisted`,
  );
  console.log(
    `  Made for kids:     ${profile.madeForKids}`,
  );
  console.log(
    `  Stream configured: ${streamConfigured}`,
  );
  console.log(
    `  Playlist enabled:  ${profile.playlist.enabled}`,
  );
  console.log(
    `  Short link set:    ${shortLinkConfigured}`,
  );
  console.log(
    `  Dry run:           ${runtime.dryRun}`,
  );

  console.log(
    "\nYouTube API content settings:",
  );
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

  console.log(
    "\nRendered description:",
  );
  console.log(
    "---------------------",
  );
  console.log(description);
  console.log(
    "---------------------",
  );

  console.log(
    "\nManual YouTube Studio settings:",
  );
  console.log(
    `  Slow mode:         ${
      profile.studioSettings
        .slowMode.enabled
        ? `${profile.studioSettings.slowMode.delaySeconds}s`
        : "disabled"
    }`,
  );
  console.log(
    `  Live reactions:    ${
      profile.studioSettings
        .liveReactions
        ? "enabled"
        : "disabled"
    }`,
  );
  console.log(
    `  Live chat:         ${profile.studioSettings.liveChat}`,
  );
  console.log(
    `  AI features:       ${
      profile.studioSettings
        .aiFeatures
        ? "enabled"
        : "disabled"
    }`,
  );
}

/**
 * Deliberately excludes broadcast IDs and watch URLs.
 */
async function writeGitHubOutputs(
  results,
) {
  if (
    !process.env.GITHUB_OUTPUT
  ) {
    return;
  }

  const outputs = {
    result_count: results.length,
    processed_profiles:
      results
        .map(
          (result) =>
            result.profileId,
        )
        .join(","),
    process_mode:
      runtime.processMode,
  };

  const lines =
    Object.entries(outputs)
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

/**
 * Deliberately excludes broadcast IDs and watch URLs.
 */
async function writeGitHubSummary(
  results,
) {
  if (
    !process.env
      .GITHUB_STEP_SUMMARY
  ) {
    return;
  }

  const sections = [
    "# YouTube Broadcast Automation",
    "",
    `Mode: \`${runtime.processMode}\``,
    "",
  ];

  for (const result of results) {
    sections.push(
      `## ${escapeMarkdown(
        result.profileId,
      )}`,
      "",
      "| Field | Value |",
      "|---|---|",
      `| Result | ${escapeMarkdown(
        result.status,
      )} |`,
      `| Target date | ${escapeMarkdown(
        result.targetDate,
      )} |`,
      `| Scheduled start | ${escapeMarkdown(
        result.scheduledStartTime,
      )} |`,
      `| Title | ${escapeMarkdown(
        result.title,
      )} |`,
      `| Existing broadcast reused | ${result.existingBroadcast} |`,
      `| Stream processed | ${result.streamProcessed} |`,
      `| Playlist processed | ${result.playlistProcessed} |`,
      `| Published | ${result.published} |`,
      `| Short.io updated | ${result.shortIoUpdated} |`,
      `| Previous broadcast demoted | ${result.previousBroadcastDemoted} |`,
      "",
      "### Manual YouTube Studio verification",
      "",
      `- Slow mode: ${
        result.studioSettings
          .slowMode.enabled
          ? `${result.studioSettings.slowMode.delaySeconds} seconds`
          : "Disabled"
      }`,
      `- Live reactions: ${
        result.studioSettings
          .liveReactions
          ? "Enabled"
          : "Disabled"
      }`,
      `- Live chat: ${escapeMarkdown(
        result.studioSettings
          .liveChat,
      )}`,
      `- AI features: ${
        result.studioSettings
          .aiFeatures
          ? "Enabled"
          : "Disabled"
      }`,
      "",
    );
  }

  await appendFile(
    process.env
      .GITHUB_STEP_SUMMARY,
    sections.join("\n"),
  );
}

function escapeMarkdown(value) {
  return String(value)
    .replaceAll("|", "\\|")
    .replaceAll("\n", "<br>");
}

