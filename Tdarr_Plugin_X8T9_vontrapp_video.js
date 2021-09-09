function details() {
  return {
    id: "Tdarr_Plugin_X8T9_vontrapp_video",
    Stage: "Pre-processing",
    Name: "Transcode video codec and resolution.",
    Type: "Video",
    Description: `[Contains built-in filter] This plugin makes sure the video is in specific codecs and below specified size.`,
    Version: "1.00",
    Tags: "pre-processing,handbrake,ffmpeg,video,resolution",
    Inputs: [
      {
        name: 'codec',
        tooltip: `Codec to use when transcoding.
        \\nExample:\\n
        hevc

        \\nExample:\\n
        avc

        \\nExample:\\n
        x264`
      },
      {
        name: 'threshold',
        tooltip: `Threshold resolution to trigger transcode.
        \\nExample (width):\\n
        540

        \\nExample:\\n
        680x510`
      },
      {
        name: 'height',
        tooltip: `Transcode target height.
        \\nExample:\\n
        480`
      },
      {
        name: 'width',
        tooltip: `Transcode target width. Default -2 (auto pick even number).
        \\nExample:\\n
        720

        \\nExample (ratio to heigth):\\n
        4:3`
      },
      {
        name: 'max_size',
        tooltip: `Trigger a transcode if file size is over this/hour
        \\nExample:\\n
        1gb`
      },
      {
        name: 'allowed',
        tooltip: 'Allowed video codecs, comma separated. Empty allows all.'
      },
      {
        name: 'denied',
        tooltip: `Denied video codecs, comma separated. If codec is in this list it will be transcoded`
      }
    ]
  };
}

function plugin(file, librarySettings, inputs) {
  //Must return this object

  var response = {
    processFile: false,
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
  var tcodec = inputs.codec || "hevc"
  var width = inputs.width || "-2"
  var height = inputs.height || "480"
  var threshold = inputs.threshold || "480"
  var thresholdw = undefined
  var max_size = numberValue(inputs.max_size)
  var allowed = inputs.allowed && inputs.allowed.split(",") || []
  var denied = inputs.denied && inputs.denied.split(",") || []
  if (threshold.split("x").length == 2) {
    [thresholdw, threshold] = threshold.split("x")
  }

  codectrans = {
    "hevc": "libx265",
    "x265": "libx265",
    "avc" : "libx264",
    "x264": "libx264",
  }
  tcodec = codectrans[tcodec] || tcodec

  var vidstream = file.ffProbeData.streams[0]
  var codec = vidstream.codec_name
  var filesize = numberValue(file.meta.FileSize.split(" ").join(""))

  var crop = undefined
  if (vidstream.tags) {
    crop = vidstream.tags.CROP
    if (crop && crop.split(":").length < 2) {
      crop = undefined
    }
  }
  // original width and height
  var ow = vidstream.width
  var oh = vidstream.height
  if (crop) {
    [ow, oh] = crop.split(":").map(x => parseInt(x))
  }
  // Check if resize needed
  if (oh > threshold || (thresholdw && ow > thresholdw)) {
    var filters = []
    if (crop) filters.push(`crop=${crop}`)
    // never increase beyond original height
    height = Math.min(oh, height)
    if ((width || "").split(":").length == 2) {
      // width specifies an aspect ratio, calculate that
      var w, h
      [w, h] = width.split(":")
      var w1, w2, w3
      // fit into ratio frame
      w1 = Math.round(height * w / h)
      if (vidstream.display_aspect_ratio) {
        // width of 1:1 pixels for new height
        var [dw, dh] = vidstream.display_aspect_ratio.split(":")
        w2 = height * dw / dh
        // if this width is smaller than requested frame ratio use it
        w1 = Math.min(w1, w2)
      }
      // make even number
      width = w1 - w1 % 2
      // don't increase beyond original width
      width = Math.min(ow, width) || ow
    } else if (width == "display") {
      // use the display aspect ratio to calculate new width (for bad players)
      var [aw, ah] = vidstream.display_aspect_ratio.split(":")
      width = Math.round(height * aw / ah)
      width = width - width % 2
      if (thresholdw && width > thresholdw) {
        width = thresholdw - thresholdw % 2
        height = Math.round(width * ah / aw)
        height = height - height % 2
      }
    }
    if (width != ow || height != oh) {
      filters.push(`scale=${width}:${height}`)
    }
    //var filters = [`scale=${width}:${height}`]
    response.processFile = true
    response.preset = `<io>-map 0:v -map 0:a -map 0:s? -map_metadata 0 -c copy -vf "${filters.join(",")}" -c:v ${tcodec} -max_muxing_queue_size 9999 -metadata:s:v:0 crop=`
    response.infoLog += `❌ Resolution too large! ${ow}x${oh} > ${inputs.threshold}[${thresholdw}, ${threshold}]\n`;
    return response;
  } else {
    response.infoLog += `✔ File resolution ${vidstream.width}x${vidstream.height} is below ${inputs.threshold}\n`;
  }

  // crop if needed
  if (crop) {
    response.processFile = true
    response.preset = `,-map 0:v -map 0:a -map 0:s? -map_metadata 0 -metadata:s:v:0 crop= -c copy -c:v ${tcodec} -vf crop=${crop}`
    response.infoLog += `❌ Video has crop metadata, applying crop ${crop}\n`
    return response
  } else {
    response.infoLog += `✔ No crop to apply\n`
  }

  // Check if codec change needed
  if (allowed.length && allowed.indexOf(codec) == -1 || denied.indexOf(codec) != -1) {
    response.processFile = true;
    response.preset = `,-map 0:v -map 0:a -map 0:s? -map_metadata 0 -c copy -c:v ${tcodec}`
    response.infoLog += `❌ Video codec ${codec} [${allowed}:${denied}] failed check\n`;
    return response;
  } else {
    response.infoLog += `✔ Video codec ${codec} is allowed! \n`;
  }

  // Transcode if too big
  var toobig = false
  if (max_size) {
    duration = file.meta.Duration || file.meta.duration || file.ffProbeData.streams[0].duration
    toobig = max_size/3600 < filesize / duration
  }
  if (toobig) {
    response.processFile = true
    response.preset = `,-map 0:v -map 0:a -map 0:s? -map_metadata 0 -c copy -c:v ${tcodec}`
    // TODO: fix bits/bytes in numberValue
    response.infoLog += `❌ File size larger than ${inputs.max_size}/hour (${max_size/1024**2/8}MiB*${duration/3600}hours) (${max_size*duration/(3600*1024**2)/8}MiB)\n`
    response.infoLog += `i File size ${filesize/1024**2/8}MiB ${max_size*duration/3600}\n`
    return response
  } else {
    response.infoLog += `✔ File size smaller than ${inputs.max_size}/hour, (${max_size/1024**2/8}*${duration/3600}hours) (${max_size*duration/(3600*1024**2)/8}MiB)\n`
    response.infoLog += `✔ File size ${filesize/1024**2/8}MiB\n`
  }

  response.processFile = false
  response.reQueueAfter = false
  response.infoLog += "✔ File meets conditions!\n";
  return response;
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

module.exports.details = details;
module.exports.plugin = plugin;
