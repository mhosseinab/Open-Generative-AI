// Reviewed hosted-media changes to the repository's pinned embedded submodules.
// Kept here because dirty Git submodules are not published by a root-repo commit.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const patches = [
  {
    "file": "packages/Vibe-Workflow/packages/workflow-builder/src/components/UploadNode.jsx",
    "beforeHash": "2cfe4877a7a33c4c5a5478f6b8fb899b820fe7a994ffe3fbe9e8a7ac41102416",
    "afterHash": "f3fb6c21f30831ec5c95da7b454247dc4283ba6a3da198e5668a9e99d4fb98c3",
    "replacements": [
      [
        "      axios.post(url, formData, {",
        "      return axios.post(url, formData, {"
      ],
      [
        "      .then(() => {",
        "      .then((uploadResponse) => {"
      ],
      [
        "        const prefix = \"https://cdn.muapi.ai/\";\n        const uploadedUrl = prefix + fields.key;",
        "        const uploadedUrl = uploadResponse.data?.url;\n        if (!uploadedUrl) throw new Error(\"Persistent upload URL missing\");"
      ]
    ]
  },
  {
    "file": "packages/Vibe-Workflow/packages/workflow-builder/src/components/RenderField.jsx",
    "beforeHash": "a1579ace9da30fb888c82a789e0c4839ddbd17eca8e367920b1e498feda1eaae",
    "afterHash": "8e85e0c492c0f57caf70f118c8a58ffb6c58e908bebc122ac80193bb8349af1d",
    "replacements": [
      [
        "      axios.post(url, formData, {",
        "      return axios.post(url, formData, {"
      ],
      [
        "      .then(() => {",
        "      .then((uploadResponse) => {"
      ],
      [
        "        const uploadedUrl = `https://cdn.muapi.ai/${fields.key}`;",
        "        const uploadedUrl = uploadResponse.data?.url;\n        if (!uploadedUrl) throw new Error(\"Persistent upload URL missing\");"
      ]
    ]
  },
  {
    "file": "packages/Vibe-Workflow/packages/workflow-builder/src/components/RenderApiField.jsx",
    "beforeHash": "dfbf06b3a9040a9ebd543e9e19f858f33d5504fcb93072feeedabd002f132b61",
    "afterHash": "8f633a4879fbb32289830ddb4c557cf98f5b9695d6e47754eab6ef8f1bafcdf1",
    "replacements": [
      [
        "      axios.post(url, formData, {",
        "      return axios.post(url, formData, {"
      ],
      [
        "      .then(() => {",
        "      .then((uploadResponse) => {"
      ],
      [
        "        const uploadedUrl = `https://cdn.muapi.ai/${fields.key}`;",
        "        const uploadedUrl = uploadResponse.data?.url;\n        if (!uploadedUrl) throw new Error(\"Persistent upload URL missing\");"
      ],
      [
        " || url.startsWith('https://cdn.muapi.ai/');",
        " || url.startsWith('https://cdn.muapi.ai/') || (/\\/api\\/stored-videos\\/[a-f0-9]{64}\\/[a-f0-9]{64}\\?/.test(url) && /[?&]type=image(?:&|$)/.test(url));"
      ]
    ]
  },
  {
    "file": "packages/Open-Poe-AI/packages/agents/src/components/EditAgent.jsx",
    "beforeHash": "ec3f4127e28316b8e12f7ff1221154bacd36673b32b0789b8691841ffb0d3e02",
    "afterHash": "db5523c8419ba39d111874ff3047ce175ef2177ac1debed9af526526bcd377a3",
    "replacements": [
      [
        "      await axios.post(url, uploadData, {",
        "      const uploadResponse = await axios.post(url, uploadData, {"
      ],
      [
        "      const prefix = usedIn === \"vadoo\" ? \"https://d3adwkbyhxyrtq.cloudfront.net/\": \"https://cdn.muapi.ai/\";\n      const uploadedUrl = `${prefix}${fields.key}`;",
        "      const uploadedUrl = uploadResponse.data?.url;\n      if (!uploadedUrl) throw new Error(\"Persistent upload URL missing\");"
      ]
    ]
  },
  {
    "file": "packages/Open-Poe-AI/packages/agents/src/AiAgent.jsx",
    "beforeHash": "a865d3faf06b23fa555c50498d7850709cbc9c0e8682372ebf10aa9cf54d3e61",
    "afterHash": "48976b411392a39af44b0c53a000d553591f0dd9342bc7b66d74380e6f55ad46",
    "replacements": [
      [
        "      await axios.post(url, formData, {",
        "      const uploadResponse = await axios.post(url, formData, {"
      ],
      [
        "      const prefix = \"https://cdn.muapi.ai/\";\n      const uploadedUrl = prefix + fields.key;",
        "      const uploadedUrl = uploadResponse.data?.url;\n      if (!uploadedUrl) throw new Error(\"Persistent upload URL missing\");"
      ],
      [
        "  const urlRegex = /(https?:\\/\\/[^\\s]+)/g;",
        "  const urlRegex = /(?:https?:\\/\\/|\\/api\\/stored-videos\\/)[^\\s<>\"')\\]]+/g;"
      ],
      [
        "    const cleanUrl = url.split(\"?\")[0].toLowerCase();\n    const isImage = /\\.(jpg|jpeg|png|gif|webp|svg)$/i.test(cleanUrl);\n    const isVideo = /\\.(mp4|webm|mov|ogg)$/i.test(cleanUrl);\n    const isAudio = /\\.(mp3|wav|mpeg)$/i.test(cleanUrl);",
        "    const cleanUrl = url.split(\"?\")[0].toLowerCase();\n    let parsed;\n    try { parsed = new URL(url, \"https://studio.invalid\"); } catch { /* Keep malformed URLs as plain text. */ }\n    const canonical = parsed && /^\\/api\\/stored-videos\\/[a-f0-9]{64}\\/[a-f0-9]{64}$/.test(parsed.pathname);\n    const hint = parsed?.searchParams.get(\"type\");\n    const mediaType = canonical ? ([\"image\", \"video\", \"audio\"].includes(hint) ? hint : \"video\") : null;\n    const isImage = mediaType === \"image\" || /\\.(jpg|jpeg|png|gif|webp|avif|svg)$/i.test(cleanUrl);\n    const isVideo = mediaType === \"video\" || /\\.(mp4|webm|mov|ogg)$/i.test(cleanUrl);\n    const isAudio = mediaType === \"audio\" || /\\.(mp3|wav|mpeg|m4a|flac|aac)$/i.test(cleanUrl);"
      ]
    ]
  },
  {
    "file": "packages/Open-AI-Design-Agent/packages/design-agent/src/CreativeCanvas.jsx",
    "beforeHash": "d4aa8102c6e9f287456256f1932fa0a98aff3a93d2a24064d4879776ebd42ff7",
    "afterHash": "56bd16995c979622f74a1ec0f97943d35782f869b51970f72a3050e970a57875",
    "replacements": [
      [
        "      await axios.post(\"/api/v1/upload-binary\", formData, {",
        "      const uploadResponse = await axios.post(\"/api/v1/upload-binary\", formData, {"
      ],
      [
        "      const uploadedUrl = `https://cdn.muapi.ai/${fields.key}`;",
        "      const uploadedUrl = uploadResponse.data?.url;\n      if (!uploadedUrl) throw new Error(\"Persistent upload URL missing\");"
      ],
      [
        "              onZoomChange={setZoomLevel} ",
        "              onZoomChange={setZoomLevel}\n              onFileUpload={processFile} "
      ],
      [
        "          const kind = a.kind || (a.url.match(/\\.(mp4|webm|mov)$/i) ? \"video\" : a.url.match(/\\.(mp3|wav|ogg|m4a)$/i) ? \"audio\" : \"image\");",
        "          const kind = a.kind || (/[?&]type=video(?:&|$)/.test(a.url) || a.url.match(/\\.(mp4|webm|mov)(?:\\?|$)/i) ? \"video\" : /[?&]type=audio(?:&|$)/.test(a.url) || a.url.match(/\\.(mp3|wav|ogg|m4a)(?:\\?|$)/i) ? \"audio\" : \"image\");"
      ]
    ]
  },
  {
    "file": "packages/Open-AI-Design-Agent/packages/design-agent/src/CanvasArea.jsx",
    "beforeHash": "d547b848eff77bc9e59b5de13f9a550c11b80864e9cc850f1300c7d161afdd27",
    "afterHash": "bb80ca7acd03c34a0f9eb7eb8448e6185739e9a94a063a3259d98d13c4b66641",
    "replacements": [
      [
        "      onZoomChange,",
        "      onZoomChange,\n      onFileUpload,"
      ],
      [
        "        if (url.match(/\\.(mp4|webm|mov)$/i)) addVideo(url);\n        else if (url.match(/\\.(mp3|wav|ogg|m4a)$/i)) addAudio(url);",
        "        if (/[?&]type=video(?:&|$)/.test(url) || url.match(/\\.(mp4|webm|mov)(?:\\?|$)/i)) addVideo(url);\n        else if (/[?&]type=audio(?:&|$)/.test(url) || url.match(/\\.(mp3|wav|ogg|m4a)(?:\\?|$)/i)) addAudio(url);"
      ],
      [
        "        const file = files[0];\n        const reader = new FileReader();",
        "        const file = files[0];\n        if (onFileUpload) {\n          void onFileUpload(file);\n          return;\n        }\n        const reader = new FileReader();"
      ]
    ]
  }
];

function sourceHash(source) {
 return createHash('sha256').update(source).digest('hex');
}
function patchSource(source, patch) {
 const digest = sourceHash(source);
 if (digest === patch.afterHash) return source;
 if (digest !== patch.beforeHash) throw new Error(`Hosted media patch refuses unknown source: ${patch.file}. Review the pinned submodule changes before updating this overlay.`);
 let result = source;
 for (const [before, after] of patch.replacements) {
  if (result.split(before).length !== 2) throw new Error(`Hosted media patch expected one source fragment: ${patch.file}`);
  result = result.replace(before, after);
 }
 if (sourceHash(result) !== patch.afterHash) throw new Error(`Hosted media patch result did not match: ${patch.file}`);
 return result;
}
function applyHostedPatches(rootDirectory = path.resolve(__dirname, '..')) {
 // Validate every source before writing anything, avoiding a partially patched build.
 const changes = patches.map(patch => {
  const filename = path.join(rootDirectory, patch.file);
  const source = fs.readFileSync(filename, 'utf8');
  return { filename, source, result: patchSource(source, patch) };
 });
 let changed = 0;
 for (const { filename, source, result } of changes) {
  if (source !== result) { fs.writeFileSync(filename, result); changed++; }
 }
 return { changed, checked: changes.length };
}
module.exports = { applyHostedPatches, patchSource, patches, sourceHash };
if (require.main === module) { const result = applyHostedPatches(); console.log(`Hosted media overlay: ${result.changed} changed, ${result.checked} checked`); }
