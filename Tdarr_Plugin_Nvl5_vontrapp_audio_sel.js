function details() {
  return {
    id: "Tdarr_Plugin_Nvl5_vontrapp_audio_sel",
    Stage: "Pre-processing",
    Name: "Select preferred audio stream, mix down, create stereo",
    Type: "Audio",
    Description: `[Contains built-in filter] This plugin removes or downmixes audio streams`,
    Version: "1.00",
    Tags: "pre-processing,audio,ffmpeg,stereo,downmix",
    Inputs: [
      {
        name: 'languages',
        tooltip: `Preferred languages
        \\nExample:\\n
        eng

        \\nExample:\\n
        eng,und,spa`
      },
      {
        name: 'channels',
        tooltip: `Preferred number of channels
        \\nExample:\\n
        6

        \\nExample:\\n
        5.1`
      },
      {
        name: 'source_channels',
        tooltip: `Prefer source streams with number of channels, comma separated
        \\nExample:\\n
        6,2

        \\nExample:\\n
        5.1`
      },
      {
        name: 'stereo',
        tooltip: `Add a stereo stream if selected stream is not stereo
        \\nExample:\\n
        true

        \\nExample:\\n
        false`
      },
      {
        name: 'codec',
        tooltip: 'Audio codec to use if transcoding'
      },
      {
        name: 'stereo_codec',
        tooltip: 'Audio codec to use for stereo, if different'
      },
      {
        name: 'allowed_codec',
        tooltip: `Audio codecs that don't need transcoding, comma separated
        \\n if empty, allow anything not denied`
      },
      {
        name: 'denied_codec',
        tooltip: "Audio codecs that do need transcoding, comma separated"
      },
      {
        name: 'max_bitrate',
        tooltip: "Transcode audio if bitrate exceeds"
      },
      {
        name: 'max_stereo_bitrate',
        tooltip: "Transcode stereo stream if bitrate exceeds"
      },
      {
        name: 'max_channel_bitrate',
        tooltip: "Transcode audio if per channel bitrate exceeds"
      },
      {
        name: 'downmix_filters',
        tooltip: `Filter used for downmix, from:to=filter
        \\nExample for pan=stereo to downmix from 5.1 to stereo:\\n
        6:2=pan=stereo|FL=FL+0.707*FC+0.707*BL+0.5*LFE|FR=FR+0.707*FC+0.707*BR+0.5*LFE`
      }
    ]
  };
}

function numberValue(val) {
  // convert prefix into number
  var num = parseFloat(val)
  if (isNaN(num)) return val
  // get remainder after number
  var l = String(num).length
  // make sure ae capture decimal floats
  if (val.substr(l, 1) == ".") l += 1
  var startl = l
  while (val.substr(0, startl).padEnd(l, "0") == val.substr(0, l)) l += 1
  l -= 1
  var suffix = String(val).substr(l)
  if (suffix) {
    suffix = suffix.toLowerCase()
    var radix = 1000
    var prefix = ["b","k","m","g","t","p"]
    var i = prefix.indexOf(suffix[0])
    if (i == -1) {
      // unknown prefix, failed to parse a number
      return val
    }
    if (suffix.substr(0,1) != "b") {
      // strip off the si prefix
      suffix = suffix.substr(1)
    }
    if (suffix.substr(0,1) == "i") {
      radix = 1024
      // strip of the si units indicator
      suffix = suffix.substr(1)
    }
    num = num * Math.pow(radix, i)
    if (suffix.substr(0,1) == "b") {
      // times whole thing by 8 for bytes
      num = num * 8
    } else if (suffix) {
      // extra characters, fail parse
      return val
    }
  }
  return num
}

function plugin(file, librarySettings, inputs) {
  //Must return this object

  var response = {
    processFile: true,
    preset: "",
    container: ".mkv", // use mkv for all intermediate transcodes, most versatile
    handBrakeMode: false,
    FFmpegMode: true,
    reQueueAfter: true,
    infoLog: "",
  };

  if (file.fileMedium !== "video") {
    console.log("File is not video");

    response.infoLog += "☒File is not video \n";
    response.processFile = false;

    return response;
  }

  // Get inputs and defaults
  var bitrate = numberValue(inputs.max_bitrate)
  var sbitrate = numberValue(inputs.max_stereo_bitrate)
  var chanrate = numberValue(inputs.max_channel_bitrate)
  var codec = inputs.codec || "ac3"
  var scodec = inputs.stereo_codec || codec
  var ycodec = inputs.allowed_codec && inputs.allowed_codec.split(",") || []
  var yscodec = ycodec // # TODO make stereo allowed/denied codecs
  var ncodec = inputs.denied_codec && inputs.denied_codec.split(",") || []
  var nscodec = ncodec
  var boolyes = ["true","t","yes","y","1"]
  var add_stereo = boolyes.indexOf(String(inputs.stereo).toLowerCase()) >= 0
  var preflanguages = (inputs.languages || "eng").split(",")
  preflanguages.reverse()
  var prefchannels = (inputs.channels || "6").split(",")
  channelmap = {"2.1":"3", "5.1": "6", "7.1": "8"}
  prefchannels = prefchannels.map(row => parseInt(channelmap[row] || row))
  prefchannels.reverse()
  srcchannels = inputs.source_channels && inputs.source_channels.split(",") || []
  srcchannels = srcchannels.map(row => parseInt(channelmap[row] || row))
  srcchannels.reverse()
  var downmix_filters = {}
  for (let f of (inputs.downmix_filters || "").split(",")) {
    var i = f.indexOf("=")
    var k = f.substr(0, i)
    var v = f.substr(i+1)
    downmix_filters[k] = v
  }

  // choose primary audio stream
  var astreams = file.ffProbeData.streams.filter(row => (row.codec_type.toLowerCase() == 'audio'))
  var pstream = undefined
  for (let [i, stream] of astreams.map((s, i) => [i, s])) {
    var newstream = []
    var lang = stream.tags && stream.tags.language || "und"
    newstream.push(["comment", stream.disposition.comment != "1"])
    newstream.push(["lang", preflanguages.indexOf(lang)])
    newstream.push(["default", stream.disposition.default == "1"])
    newstream.push(["index", 100-i])
    newstream = [newstream, i, stream]
    if (pstream === undefined || pstream < newstream) pstream = newstream
  }
  var [psort, pi, pstream] = pstream
  var pstream_src_id = pstream.tags && pstream.tags["SOURCE_ID-eng"] || undefined
  var astream = undefined
  var firststream = undefined
  for (let [i, stream] of astreams.map((s, i) => [i, s])) {
    var newstream = []
    var lang = stream.tags && stream.tags.language || "und"
    var srcid = stream.tags && stream.tags["SOURCE_ID-eng"] || "und"
    var srcidmatch = srcid === pstream_src_id
    var cname = stream.codec_name
    var codecmatch = ycodec && ycodec.indexOf(cname) != -1 ||
                     ncodec.indexOf(cname) == -1
    var bitratehigh = bitrate && bitrate < bit_rate
    var chanratehigh = chanrate && chanrate < bit_rate / stream.channels
    var channelmatch = prefchannels.indexOf(stream.channels)
    var no_tcode = codecmatch && !bitratehigh && !chanratehigh && channelmatch != -1
    newstream.push(["comment", stream.disposition.comment != "1"])
    newstream.push(["comment_unlikely", srcidmatch])
    newstream.push(["srcidmatch", srcidmatch])
    newstream.push(["lang", preflanguages.indexOf(lang)])
    newstream.push(["srcchannels", srcchannels.indexOf(stream.channels)])
    newstream.push(["tcode", no_tcode])
    newstream.push(["channelpref", prefchannels.indexOf(stream.channels)])
    newstream.push(["default", stream.disposition.default == "1"])
    newstream.push(["index", 100-i])
    newstream.push(["codec_pref", (ycodec || []).slice().reverse().indexOf(cname)])
    newstream.push(["bitrate", bit_rate])
    console.log(newstream)
    newstream = [newstream, i, stream]
    if (astream === undefined || astream < newstream) astream = newstream
    if (firststream === undefined) firststream = newstream
  }
  var [asort, ai, astream] = astream

  // downmix to most preferred channels lower than existing channels
  var achannels = astream.channels
  for (let c of prefchannels) {
    if (astream.channels > c) achannels = c
  }

  var sstream = undefined
  var ssort, si
  // add stereo if asked for and achannels is not also stereo
  if (add_stereo && achannels > 2) {
    for (let [i, stream] of astreams.map((s, i) => [i, s])) {
      var newstream = []
      var cname = stream.codec_name
      var lang = stream.tags && stream.tags.language || "und"
      var srcid = stream.tags && stream.tags["SOURCE_ID-eng"] || "und"
      var codecmatch = yscodec && yscodec.indexOf(cname) != -1 ||
                       nscodec.indexOf(cname) == -1
      var bit_rate = stream.bit_rate
      if (!bit_rate && stream.tags) {
        bit_rate = stream.tags["BPS-eng"]
      }
      var bitratehigh = sbitrate && sbitrate < bit_rate
      var chanratehigh = sbitrate === undefined && chanrate &&
                         chanrate < bit_rate / stream.channels
      var channelmatch = stream.channels == 2
      var no_tcode = codecmatch && !bitratehigh && !chanratehigh && channelmatch
      newstream.push(["comment", stream.disposition.comment != "1"])
      newstream.push(["srcid_match", srcid === pstream_src_id, srcid, pstream_src_id])
      //newstream.push(["comment_unlikely", i <= 3 || stream.channels > 2])
      newstream.push(["lang", preflanguages.indexOf(lang)])
      newstream.push(["tcode", no_tcode])
      newstream.push(["srcchannels", srcchannels.indexOf(stream.channels)])
      newstream.push(["default", stream.disposition.default == "1"])
      newstream.push(["index", 100-i])
      newstream.push(["codec_pref", (yscodec || []).slice().reverse().indexOf(cname)])
      newstream.push(["bitrate", bit_rate])
      newstream.push(["tcode", [codecmatch, bitratehigh, chanrate, bit_rate, chanratehigh, channelmatch]])
      console.log(`DEBUG: ${newstream}`)
      newstream = [newstream, i, stream]
      if (sstream === undefined || sstream < newstream) sstream = newstream
    }
    [ssort, si, sstream] = sstream
  }

  // check if audio streams need pruning or reordering
  if (ai != 0 || (si !== undefined && si != ai && si != 1) || (astreams.length > (si === undefined && 1 || 2))) {
    var amap = []
    amap.push("-map")
    amap.push(`0:a:${ai}`)
    if (si !== undefined && si != ai) {
      amap.push("-map")
      amap.push(`0:a:${si}`)
    }
    response.preset = `<io>-map 0:v ${amap.join(" ")} -map 0:s? -c copy -max_muxing_queue_size 9999`
    response.infoLog += `❌ Selected audio streams ${ai} (${si})\n`
    return response
  }
  response.infoLog += `Selected audio streams ${ai} (${si})\n`

  // Downmix second stream to stereo, do first since might also use first stream
  if (si !== undefined && sstream.channels > 2) {
    if (astream.bit_rate / astream.channels > sstream.bitrate * 1.1 / sstream.channels) {
      si = ai
      sstream = astream
    }
    amap = `0:a:${si}`
    downmix = downmix_filters[[sstream.channels, 2].join(":")]
    if (downmix) {
      downmix = `-filter:a:1 "${downmix}"`
    } else {
      downmix = `-ac:a:1 2`
    }
    response.preset = `<io>-map 0:v -map 0:a:0 -map ${amap} -map 0:s? -c copy -c:a:1 ${scodec} ${downmix} -metadata:s:a:1 title=Stereo`
    response.infoLog += `❌ Downmixing stereo stream\n`
    return response
  }

  // Check if first audio stream needs downmix
  console.log(`achannels = ${achannels} ${prefchannels}`)
  if (astream.channels != achannels) {
    amap = "0:a:0"
    downmix = downmix_filters[[astream.channels, achannels].join(":")]
    if (downmix) {
      downmix = `-filter:a:0 "${downmix}"`
    } else {
      downmix = `-ac:a:0 ${achannels}`
    }
    var surround_map = {
      6: "Surround 5.1",
      8: "Surround 7.1",
      3: "Surround 2.1",
      2: "Stereo",
    }
    var title = surround_map[achannels] || `Surround ${achannels} channels`
    response.preset = `<io>-map 0:v -map ${amap} -map 0:a:1? -map 0:s? -map_metadata 0 -c copy -c:a:0 ${codec} ${downmix} -metadata:s:a:0 title="${title} (Downmix)"`
    response.infoLog += `❌ Downmixing first audio ${astream.channels} to ${achannels}\n`
    return response
  }

  // Transcode if bit_rate is too high, first stream
  var abit_rate = astream.bit_rate
  if (!abit_rate && astream.tags) {
    abit_rate = astream.tags["BPS-eng"]
    console.log(`abit_rate ${abit_rate} ${abit_rate/astream.channels}`)
  }
  if (bitrate && bitrate < abit_rate || chanrate && chanrate < abit_rate / astream.channels) {
    response.preset = `<io>-map 0:v -map 0:a -map 0:s? -c copy -c:a:0 ${codec}`
    if (bitrate && bitrate < astream.bit_rate) {
      response.infoLog += `❌ First audiostream bitrate ${abit_rate} > ${bitrate}\n`
    } else {
      response.infoLog += `❌ First audiostream channel rate ${abit_rate/astream.channels} > ${chanrate}\n`
    }
    return response
  }

  // Transcode if bit_rate is too high, second stream
  console.log(`checking stereo bitrate ${si}`)
  if (si !== undefined && (sbitrate < sstream.bit_rate ||
      sbitrate !== undefined && chanrate < sstream.bit_rate / 2)) {
    response.preset = `<io>-map 0:v -map 0:a -map 0:s? -c copy -c:a:1 ${scodec}`
    if (sbitrate < sstream.bit_rate) {
      response.infoLog += `❌ Stereo stream bitrate ${sstream.bit_rate} > ${sbitrate}\n`
    } else {
      response.infoLog += `❌ Stereo stream channel rate ${sstream.bit_rate/2} > ${chanrate}\n`
    }
    return response
  }

  response.processFile = false
  response.reQueueAfter = false
  response.infoLog += `✔ File meets audio conditions\n`
  return response
}

module.exports.details = details;
module.exports.plugin = plugin;
