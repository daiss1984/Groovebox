# Groovebox 云端唱片室

Groovebox 是在本机运行的网页版音乐播放器，可播放百度网盘、Google Drive、OneDrive、Dropbox、Box、pCloud、阿里云盘、115 网盘、123 云盘、光鸭云盘、媒体服务器和本地音乐。打开网页即可试听内置演示曲，无需登录。

## 启动

使用 Node.js 22.9 或更新版本。在本目录运行：

```sh
npm ci
npm start
```

打开 [http://localhost:5187](http://localhost:5187)。在首页点「立即播放」试听，或点「导入音乐」选择自己的文件。在「音乐来源」可导入整个本地文件夹。把同名的 LRC、VTT 或纯文本 YRC、QRC、KRC 与音频一起导入，可在「歌词」页查看同步歌词并点击跳播。

新导入的音频和图片会保存为浏览器中的独立副本。不同录音使用同一文件名时，可选「保留两首」或「替换已导入副本」，相同内容再次导入会自动去重。保留两首会保留原曲目的歌单与收藏；替换会更新选中的曲目，重新匹配其歌词，设备上的文件不受修改。

重选已经导入的同名文件夹时，可选择「更新已有曲集」或「导入为独立曲集」。独立导入会分开保存目录、封面和歌词。更新会移除已不在该目录中的文件夹歌词，并回退到内嵌歌词；单独手动导入的歌词和浏览器已保存的音频副本继续保留。浏览器无法提供所选目录的完整设备路径，因此需要用这一步区分同名目录。

旧版路径关联的本地记录会在重新选择音频后保存独立副本，之前已被设备改写且未独立保存的历史内容无法恢复。若升级时提示关闭其他标签页，关闭仍使用旧版曲库的页面后刷新即可，已有曲库会保留。

已连接网盘可在「音乐来源」或网盘目录开启「直连模式」。打开目录即可播放，实际播放的歌曲会出现在首页。切换模式会保留已有索引、歌单、收藏与离线副本。 [Cotton Music 5.5.0 发布记录](https://github.com/pure-music/PureMusic/releases/tag/v5.5.0)

网盘、WebDAV 和 SMB 来源可单独设置「文件名解析」。选择「使用文件名」后，`name` 使用完整歌名，也可设置 `name-artist`、`name_artist`、`track-name-artist` 或 `track-name`。将专辑目录命名为「专辑-艺人」可补齐专辑和艺人。目录浏览立即使用新规则，重新扫描后曲库也会更新。 [Cotton Music 文件名规则](https://music.caij.xyz/zh/faq/)

扫描网盘时，默认从根目录向下读取四层。可在网盘目录将当前位置设为扫描起点，也可手动打开或收录更深的目录。 [Cotton Music 目录设置](https://music.caij.xyz/zh/faq/)

浏览器可解码时直接播放源文件。安装 FFmpeg 后，APE、DSF/DFF、WavPack 等文件遇到解码失败可自动尝试兼容播放，也可从曲目菜单手动启动。浏览器支持 FLAC 时优先生成 FLAC，其余采用高质量可变码率 MP3。MP3 会在格式允许时保留原采样率和声道数。将 DSD 转为 FLAC 时会先解码为 PCM。转换的输入上限为 128 MiB，输出上限为 64 MiB。可用 `FFMPEG_PATH` 指定 FFmpeg 的可执行文件。 [FFmpeg FLAC 编码说明](https://ffmpeg.org/ffmpeg-codecs.html#flac-2)

手动打开播放侧栏或沉浸播放可查看已读到的音频格式、码率和采样率。对于支持分段读取的远程曲目，播放器会少量读取正在播放的文件以获取信息。兼容播放会列出实际转换文件的格式和码率，媒体服务器的串流请求上限也会单独显示。 [Cotton Music 播放详情](https://github.com/pure-music/PureMusic/releases/tag/v5.1.1)

当前曲目使用兼容音频时，可在曲目或队列菜单点「切回原始音源」。切换保留播放位置、播放状态和队列。浏览器仍无法解码原文件时，会恢复兼容音频。

## 歌单缓存、本地文件和音质

- 在歌单点「缓存全部歌曲」，只预缓存点击时歌单中的歌曲；之后新增的成员需要再次点击。本地导入的音乐不重复复制。单独的「提前缓存歌单」会持续缓存已有歌曲和之后新增的歌曲，停止自动缓存会保留已完成的副本。
- 「设置 → 缓存 → 缓存管理」显示歌曲、图片、歌词及全部缓存用量，可分别清理。歌曲默认上限 1024 MiB、最低 200 MiB；图片默认 250 MiB、最低 50 MiB。自动音频超过预算时按最近访问顺序淘汰，持续缓存不会反复下载本轮已淘汰的曲目；可手动重试。
- 「离线保存」、自动缓存曲目菜单中的「固定离线副本」，以及从缓存另存原文件或打包 ZIP，会将对应音频标为固定副本。自动淘汰和缓存清理保留固定副本、导入的本地音乐及已下载到设备的文件。旧版保存的离线曲目升级后均按固定副本保护；单独的「删除离线副本」仍会删除所选曲目。
- 清理歌曲或图片缓存后，会暂停相应的后台缓存写入。在缓存管理点「恢复自动缓存」可恢复；主动开始一次预缓存或重新开启歌单自动缓存，也会恢复歌曲缓存。清理会阻止其他标签页和旧下载任务迟到写回，保留当前正在播放的音频。
- 「下载歌单」打包原始音频。完成后点「保存 ZIP 到本地」，浏览器会保存到下载位置。当前单首上限为 256 MB，ZIP 总大小须小于 4 GiB。浏览器存储不足时，仍可保存已生成的 ZIP。
- 单曲菜单的「保存原始音频到本机」可将曲目另存到浏览器的下载位置。已缓存的曲目也可以在断网时保存。浏览器可能按音频类型调整扩展名，例如将 `.m4a` 改为 `.mp4`。
- 播放器侧栏的「分类」按音乐标签中的流派浏览曲库，支持一首歌归入多个流派。没有流派标签的歌曲会出现在「未分类」。已有本地文件可重新导入以补读流派。
- 在「设置 → 曲库」可按行填写流派分隔符和保留原样的完整流派名。例如用 `／` 拆分组合流派，将 `R&B／ソウル` 加入例外即可保留这个名称。规则适用于分类、搜索和下载筛选，也可随备份恢复。
- 媒体服务器提供合作艺人名单时，同一首歌可进入每位艺人的分类。「设置 → 曲库」可通过艺人分隔符与完整艺人名例外调整归类。规则也适用于搜索和下载筛选，歌曲仍显示原始署名。 [Cotton Music 艺人分类设置](https://github.com/pure-music/PureMusic/issues/131)
- 同名专辑按专辑艺人标签区分，专辑总览也可按专辑艺人排序。缺少这个标签的同名歌曲默认合在一起，适合多歌手原声带。可在「设置 → 曲库」开启「专辑缺少艺人标签时使用歌曲艺人」来分别归类。 [Cotton Music 专辑艺人设置](https://github.com/pure-music/PureMusic/issues/130)
- 在专辑、艺人、歌单和流派详情中，长按一首歌可直接进入多选。也可以用列表顶部的「多选」按钮。 [Cotton Music 长按多选](https://github.com/pure-music/PureMusic/issues/135)
- 「已下载音乐」汇集缓存的曲目和手动导入的本地音频，可以搜索，按来源类别、艺人、专辑和流派筛选，或单首及批量删除播放器中的副本。扫描文件夹时会扫描子目录，关联同名歌词，并为缺少内嵌封面的曲目读取同目录中的 `cover.png`、`cover.jpg` 或 `cover.jpeg`。删除保留设备上的原始文件和网盘源文件。 [Cotton Music 文件夹封面教程](https://music.caij.xyz/zh/faq/)
- 扫描本地目录时，可将艺人照片放在该目录的 `artist` 子目录，使用 `艺人名.png`、`艺人名.jpg` 或 `艺人名.jpeg`。艺人页可在断网时显示该照片。重新扫描会更新已替换或移除的照片。 [Cotton Music 艺人照片教程](https://music.caij.xyz/zh/faq/)
- 从曲库移除歌曲时，可以选择是否同时移除播放器里的本地副本。网盘上的歌曲仍可从来源目录打开，也可在歌曲菜单加回曲库。重新扫描会保留移除状态。
- 在云端目录或含有云端歌曲的曲目列表点「批量读取音频标签」，可将内置的标题、艺人、封面、歌词和流派补入曲库。读取使用 HTTP Range，显示进度，可取消，并跳过已有读取结果的曲目。 [Cotton Music 批量标签说明](https://github.com/pure-music/PureMusic/issues/184)
- 首次在线打开并加载离线页面资源后，可断网重新打开同一浏览器中的「已下载音乐」。每次构建从网页资源生成版本标识，浏览器在线更新离线页面时会保留已缓存的音频。
- 新保存的百度网盘、WebDAV 或 SMB 曲目也会尝试在浏览器内保留该曲目的目录封面。移除下载会同时删除对应封面副本。
- 播放默认读原始音频。「设置 → 原声」恢复正常速度，关闭音量标准化并将均衡器归零。启用均衡器或音量标准化时会依据可用峰值标签和滤波响应预留电平，减少削波风险。用过音效的页面会继续经过 Web Audio。保持原声设置并刷新后，以浏览器原生方式播放。输出采样率仍由浏览器、系统混音和音频设备共同决定。 [Web Audio 规范](https://www.w3.org/TR/webaudio/#MediaElementAudioSourceNode)
- 「设置 → 音频」提供十段均衡器和独立开关，默认关闭。可选择平直、人声、爵士、摇滚、舞曲、古典、嘻哈或深夜预设，也可命名保存自定义配置。关闭会保留曲线，重置保留开关状态。旧五段配置保留原频率和增益，可与新预设切换；均衡器配置会随备份恢复。
- 在「正在播放 → 歌词」可手动在线匹配。只有歌名时也可查找并从候选中选择版本。歌词可按行或逐字同步。已有内嵌、同名文件或媒体服务歌词时也可手动匹配。结果和来源选择会保存在当前浏览器，可用「使用原歌词」切回。同时间点的多行同步译文可一起显示。「设置」中的自动匹配仅在歌曲实际播放后查询缺失歌词。 [LRCLIB](https://lrclib.net/docs) · [OpenSubsonic 同步歌词规范](https://opensubsonic.github.io/docs/responses/structuredlyrics/)
- 可在歌曲菜单或专辑详情点「查找在线封面」，也可在设置开启自动查找。播放器优先显示有效的原封面。百度网盘、WebDAV 和 SMB 曲目缺少原封面时可使用同目录的 `cover.png`、`cover.jpg` 或 `cover.jpeg`。查找在线封面时优先使用专辑艺人标签。已显示的近期在线封面会缓存在本浏览器，断网播放已下载歌曲时也能显示。 [MusicBrainz API](https://musicbrainz.org/doc/MusicBrainz_API/Search) · [Cover Art Archive API](https://musicbrainz.org/doc/Cover_Art_Archive/API)
- WebDAV 和 SMB 支持从已配置根目录的 `artist` 子目录读取艺人照片。例如来源配置在 `/Music/` 时，可放入 `/Music/artist/ÉCHO 乐队.jpg`。支持 PNG、JPG 和 JPEG。照片按完整艺人名称匹配，更换或移除后可刷新目录或重扫曲库。同名艺人来自多个来源时，可通过来源筛选选择照片。照片需连接该来源才能加载。读取失败后，艺人页面会在 30 秒后重试，恢复联网也会立即重试。 [Cotton Music 艺人照片教程](https://music.caij.xyz/zh/faq/)

在「设置 → 界面语言」切换简体中文、English、日本語或 한국어。选择保存在当前浏览器，可随设置备份恢复。曲名、专辑名、歌单名和歌词按原文显示。

在「设置 → 外观」可开启「多行显示歌曲标题」，让歌曲列表和队列中的长曲名换行。这里也可调整歌词字体粗细，应用到歌词侧栏、迷你歌词和沉浸播放。两项设置可随备份恢复。 [Cotton Music 曲名设置](https://github.com/pure-music/PureMusic/releases/tag/v3.6.7) · [Cotton Music 歌词字重](https://github.com/pure-music/PureMusic/releases/tag/v4.4.2)

「设置 → 音频 → 全屏歌词文字居中」默认关闭。开启后，全屏播放的右栏歌名、艺人、歌词和翻译会居中，封面布局、侧栏歌词及播放队列保持原样。切换会保留当前播放和歌词滚动位置，设置可随备份恢复。

歌单、艺人、专辑、下载和云端目录可以分别设置排序。从排好序的列表开始播放时，队列使用当前顺序。歌单原始顺序可从「默认顺序」恢复。

侧栏「歌单」标题旁的「调整歌单顺序」可移动整个歌单。顺序会保存在本机，并随 WebDAV 自动同步。 [Cotton Music 歌单顺序](https://github.com/pure-music/PureMusic/issues/136)

新用户默认按创建时间最新优先显示歌单，新建及 M3U 导入的歌单也会放到手动顺序开头。已有用户的手动顺序和明确选择会保留。「添加到歌单」窗口独立按已知创建时间最新优先排列，不跟随侧栏的名称排序或手动调整。 [Cotton Music 新歌单位置](https://github.com/pure-music/PureMusic/issues/170) · [添加窗口顺序](https://github.com/pure-music/PureMusic/issues/105)

该窗口也可选择按歌单名称、创建时间或最新修改时间排序。改名、增加或移除歌曲会更新修改时间，单纯调整顺序或读取音频标签不会更新。切回「手动顺序」可恢复原顺序。创建和修改日期随完整备份、WebDAV 歌单备份及自动同步保留，旧歌单缺少日期时排在已知日期之后，不会以恢复时间补填。合并时保留已有本地创建日期，修改日期取已知的较新值。旧版 WebDAV 客户端可读取歌单，重新保存时可能省略日期。 [Cotton Music 3.3.1](https://github.com/pure-music/PureMusic/releases/tag/v3.3.1)

专辑页可按发行年份排序。年份只在年份排序模式显示，缺少年份的专辑排在末尾。

新用户的歌曲列表默认按歌名排序；已有用户的顺序和明确选择会保留。歌曲列表也支持发行年份升序、添加时间和文件修改时间双向排序。发行年份缺失的歌曲排在年份升序开头。本地和 WebDAV 的添加时间按原版行为使用文件修改日期，重新扫描会更新两种日期；其他来源暂不补造添加时间。未知日期按原版的零值参与排序，不会用导入或恢复时刻补填。

歌单切换排序只改变当前查看与起播顺序，重复曲目继续保留。切回默认顺序可恢复手动顺序。歌曲日期随本机完整备份和 WebDAV 歌单同步保留，本地音频日期仍来自当前浏览器保存的文件副本。

在「设置 → 音频」开启「在专辑详情显示歌曲播放进度」，可查看每首已播放歌曲在当前浏览器中的最近进度。页面刷新后会保留进度。 [Cotton Music 5.5.0 发布记录](https://github.com/pure-music/PureMusic/releases/tag/v5.5.0)

专辑总览和艺人详情里的专辑区可分别选择自动布局或固定列数。点击艺人详情中的专辑会打开整张专辑，包括其他参与艺人的歌曲。点击专辑详情中的专辑艺人，可打开艺人详情并返回其署名的专辑。 [Cotton Music 专辑网格](https://github.com/pure-music/PureMusic/issues/152) · [专辑艺人入口](https://github.com/pure-music/PureMusic/issues/67)

在歌单详情选择「默认顺序」，再点「手动排序」可用每行的上移、下移按钮调整保存顺序。新建播放队列按调整后的顺序播放，已在播放的队列继续使用自己的顺序。

在歌单中用「搜索此歌单」查歌曲、艺人或专辑。点搜索结果会从该首歌开始播放整个歌单。「定位当前歌曲」会滚动到正在播放的曲目，必要时清除当前筛选。双击歌单标题可回到顶部。 [Cotton Music 歌单搜索](https://github.com/pure-music/PureMusic/issues/154) · [歌单定位与回顶](https://github.com/pure-music/PureMusic/issues/137)

开启「设置 → 音频 → 记住每个歌单上次播放的歌曲」后，歌单的「全部播放」会从上次曲目的开头开始。可以点击其他曲目手动起播。同一首歌出现在多个位置时会记住实际播放的位置。若服务器调整了顺序且无法确认重复条目，则从第一首开始。此设置默认关闭。 [Cotton Music 歌单播放位置](https://github.com/pure-music/PureMusic/releases/tag/v2.6.3)

「导入 M3U 歌单」可读取 `.m3u` 和 `.m3u8`，保留文件里的歌单名和曲目顺序。先导入本地音频或扫描已连接的云端目录。支持已收录的 WebDAV 文件地址和 Navidrome 导出歌单。若 Navidrome 提供的是虚拟文件名，播放器也可按导出文件里的艺人和曲名唯一匹配。导入时会报告跳过的条目。

打开 Navidrome、OpenSubsonic、Subsonic 或 Jellyfin 音乐来源，点「服务器歌单」即可浏览和播放服务器上的歌单。队列保留服务器定义的顺序及服务器返回的重复曲目。 [OpenSubsonic 服务器歌单接口](https://opensubsonic.github.io/docs/endpoints/getplaylist/) · [Jellyfin 歌单接口](https://github.com/jellyfin/jellyfin/blob/master/Jellyfin.Api/Controllers/PlaylistsController.cs#L461)

Emby 的「服务器歌单」可浏览或新建音频歌单。在歌曲菜单中选「添加到 Emby 歌单」，或在歌单曲目行点「从 Emby 歌单移除」。移除一次只删除该位置的条目，音乐文件仍可播放。新建的空歌单在当前服务器连接中可立即添加歌曲。 [Emby 歌单接口](https://dev.emby.media/doc/restapi/Playlists.html)

Jellyfin 10.9 及以后也提供新建私有音乐歌单、添加和移除条目的入口，已在真实 12.4 验证。使用账号密码或用户访问令牌时，播放器会核对当前用户及歌单编辑权限。只读共享歌单仍可浏览和播放。使用管理员 API 密钥时，连接表单须填写指定用户 ID，播放器会先验证密钥权限、用户和歌单可见性。界面会说明，这类连接的添加操作受指定用户权限限制，移除操作使用管理员权限。 [Jellyfin 歌单接口](https://github.com/jellyfin/jellyfin/blob/master/Jellyfin.Api/Controllers/PlaylistsController.cs)

Jellyfin 若为同一歌曲的多处记录返回相同条目标识，只能一次移除该歌曲的所有条目。播放器会显示当前读取的数量并请求确认，提交前再核对数量与对应曲目。已发现变化的旧操作会被拒绝。服务器没有提供带版本条件的移除接口，其他客户端仍可能在最后核对后改动歌单。移除歌单条目保留原始音频、封面和歌词。

Jellyfin 写入结果无法确认时，播放器会重新读取服务器歌单供核对，不自动再次提交。新建歌单后若响应丢失，会返回歌单目录，先查看实际结果再决定是否重新创建。

在服务器歌单点「保存为本地镜像」，可通过侧栏重新打开浏览器中保存的歌单。重新连接媒体服务器后可手动刷新镜像，更新歌名与曲目顺序。离线时可以从镜像播放已另外下载的歌曲。

「设置 → 音频」里的直连列表入队选项默认开启。关闭后，从服务器歌单或已识别的直连专辑、艺人列表点一首歌，只加入选中的那一项。使用列表明确提供的整组播放按钮仍可播放整组。 [Cotton Music 3.4.0](https://github.com/pure-music/PureMusic/releases/tag/v3.4.0)

较大的云端曲目和目录索引存入当前浏览器的 IndexedDB，设置、歌单、收藏与队列继续保存在较小的浏览器状态中。扫描先完成索引事务再提示成功，写入失败或取消会保留旧索引；其他标签页更新同一索引后，需要刷新再编辑。Chrome、Firefox 和 WebKit 已验证真实 WebDAV 20,000 首歌曲的扫描、刷新、搜索、收藏、队列恢复及完整／删减版备份恢复。完整备份仍使用原有可携带的 JSON 格式。

恢复完整云端曲库备份时，先暂存索引和独立的设置版本，再一次提交可见版本。页面意外关闭后，重新打开会恢复为完整的旧版本或新版本；旧标签页不能把自己的设置写进新版本。候选设置损坏或无法读取时，界面保留原数据并提示重试；可确认放弃尚未提交的恢复。测试包含 Chromium 渲染进程真实崩溃，以及三个浏览器中的损坏候选、存储拒绝与跨标签页冲突。浏览器存储不提供系统断电的持久写入保证。

全局搜索可按名称或路径找到已导入的本地文件夹和已扫描的云端文件夹。搜索使用本机索引，打开云端结果时才读取目录。旧索引中只保存了内部编号的目录可重新扫描来补齐名称。

在本地或云端文件夹里可点击顶部工具栏空白处或「回到顶部」，当前目录和播放进度会保留。 [Cotton Music 文件夹回顶](https://github.com/pure-music/PureMusic/issues/174)

在「音乐来源」的来源卡片上点「从曲库隐藏」，即可从全部歌曲、搜索、推荐和分类中暂时移除该来源。点「在曲库显示」会立即复用已有的曲目和目录索引。已下载音乐、收藏、已有歌单和播放队列仍可打开，隐藏设置会随备份恢复。 [Cotton Music 来源可见性](https://github.com/pure-music/PureMusic/issues/162)

在「全部歌曲」点「刷新曲库」，可以依次更新已扫描、已连接且在曲库显示的云端来源。可随时取消。某个来源刷新失败时会保留原索引，并继续刷新其他来源。 [Cotton Music 一键刷新](https://github.com/pure-music/PureMusic/issues/153)

在云端目录点「选择要收录的目录」，可勾选多个子目录增量加入曲库。已收录的目录会标记出来。若从未整体扫描父目录，以后刷新曲库时会继续只读取已收录的目录。

本地或云端目录播放过后，可在同一浏览器点击「继续播放目录」，回到该目录上次播放的歌曲和进度。需要从头播放时，可使用「全部播放」或「播放此目录」。

「设置 → 音频」里的「打开播放器时恢复上次播放进度」默认为开启。关闭时，重新打开页面会保留播放队列和当前曲目，曲目从头暂停。 [Cotton Music 播放设置](https://github.com/pure-music/PureMusic/issues/30#issuecomment-3117218024)

首页推荐优先使用已收录的音乐，按专辑集中展示，结合播放次数、最近播放与收藏排序。没有专辑信息的推荐可直接播放。随机模式下，多首歌曲每轮会随机遍历队列，列表循环换轮时会避开紧接着重播上一首。「上一首」可按实际访问顺序回退，手动指定的「下一首播放」优先。刷新页面会恢复之前的随机播放进度、历史和待播优先项。

点击播放栏中的歌曲名可定位曲目。播放器优先滚动当前列表，必要时转到「全部歌曲」。在「设置 → 音频」可启用点击歌曲后自动打开播放详情。

桌面浏览器可把指针放在音量滑块上，通过滚轮调节音量。向上提高，向下降低。 [Cotton Music 滚轮音量](https://github.com/pure-music/PureMusic/issues/186)

在「设置 → 外观」开启「播放键颜色跟随封面」，播放键会随当前专辑封面变色。封面缺失时使用主题颜色。 [Cotton Music 播放键取色](https://github.com/pure-music/PureMusic/issues/166)

播放云端歌曲时，播放器会尝试预读队列中的下一首。支持字节范围且不超过 8 MiB 的音频可从内存直接开始播放；其余音频切换时按原方式串流。离线下载可另行保存完整音频。 [Cotton Music 下一首预加载](https://github.com/pure-music/PureMusic/issues/189)

「设置 → 音频 → 媒体服务器码率」可为 Navidrome、Subsonic 和 OpenSubsonic 分别设置 Wi-Fi 和移动数据码率。浏览器能识别网络类型时可自动切换，也可手动选。码率上限从下一次播放时生效，下载副本仍使用原始音源。 [Cotton Music 码率设置](https://github.com/pure-music/PureMusic/issues/61)

在播放侧栏或沉浸播放页，双击歌词可暂停或继续。单击或用键盘激活带时间标记的一行可跳转。 [Cotton Music 双击歌词](https://github.com/pure-music/PureMusic/issues/155)

在沉浸播放页点击「歌词专注」可隐藏播放控件和进度条，歌词保持可点击。按 Esc 或再次点击按钮恢复控件。离开沉浸页时自动关闭专注模式。 [Cotton Music 4.4.2](https://github.com/pure-music/PureMusic/releases/tag/v4.4.2)

「设置 → 音频 → 清理歌词缓存」可以清除在线匹配和已读取的远程歌词缓存。导入或内嵌歌词、离线音频仍可使用。播放中的歌词显示会暂留到停止或切歌。 [Cotton Music 2.1.1](https://github.com/pure-music/PureMusic/releases/tag/v2.1.1)

已有在线匹配后，点「浏览其他歌词版本」可以按艺人、专辑或时长挑选 LRCLIB 候选。选定候选后切换歌词，关闭窗口会保留当前版本。 [LRCLIB 搜索接口](https://lrclib.net/docs.txt)

OpenSubsonic 服务器为歌曲提供多个歌词版本时，可在播放侧栏或沉浸模式打开「服务器歌词版本」，按语言选择同步歌词或纯文本歌词。选择按歌曲保存在当前浏览器，服务器调整返回顺序后仍可保留。已有在线匹配也可继续切换。有多个主歌词版本但缺少对应关系时，独立译文不会混入任何一个版本。 [OpenSubsonic 歌词格式](https://opensubsonic.netlify.app/docs/responses/structuredlyrics/)

「设置 → 音频 → 配置歌词 API」可选择自定义 LRCLIB 或 HisAtri 接口。请在运行 Groovebox 的电脑上通过 `localhost` 打开设置，填写完整 HTTP 或 HTTPS 接口地址，保存后立即生效。地址不带查询参数、片段或用户名密码；认证信息放入请求头，例如 `Authorization=Bearer token&X-Api-Key=value`。LRCLIB 预填官方查询地址，HisAtri 需填写实际歌词接口地址。

请求头加密保存在服务端的 `.groovebox/metadata-settings.bin`，表单不会读回旧值，也不加入浏览器存储和导出备份。可选择保留、替换或移除请求头；更换接口来源会清除旧认证信息。配置随服务器重启保留。

「设置 → 曲库 → 配置封面 API」可设置 HisAtri 图片接口，分别开启自定义专辑封面和艺人照片。这两个开关独立于内置的在线图片查找开关。本地内嵌图片、文件夹封面及已连接来源的艺人照片优先。接口无结果或失败时，不会自动转发歌曲信息给公开图片服务；关闭对应自定义开关后，可继续使用已启用的内置查找。

图片接口配置独立加密保存在 `.groovebox/metadata-artwork-settings.bin`，不会改变歌词接口配置。请求头的保留、替换和移除方式与歌词接口相同。支持 PNG、JPEG、GIF 和 WebP，单张图片上限 2 MB。服务端临时图片地址过期后，播放器会核对当前配置再尝试更新，避免重复请求已停用的接口。

下载曲目时会保存可用的自定义专辑封面，与原音频一同留在当前浏览器。关联使用接口配置版本和专辑信息，服务端临时地址轮换不影响已保存的封面。删除下载时同时删除图片副本。已浏览的近期图片也可通过网页缓存离线显示，是否保留取决于浏览器容量与缓存清理；已明确停用或改变的接口不会继续显示其旧匹配结果。

开启「缺少歌词时自动在线匹配」后，自定义接口用于缺失歌词的自动查询，内嵌歌词、同名歌词文件和媒体服务器提供的歌词优先。关闭自动匹配仍可手动查询，并切回原歌词。自定义接口没有结果或请求失败时，可点「浏览其他歌词版本」，明确提交后再查询公开 LRCLIB。各接口分别限流。设置改变或自动切歌后，旧查询不会写入新的歌词；旧窗口需要重新打开。

「设置 → 音频 → 逐字歌词效果」可选择关闭、透明度渐变、匀速滑动或准确滑动，默认透明度渐变。匀速滑动从首词开始到末词结束按整行匀速推进；准确滑动按逐词时间和词序推进。切换保持音频、歌词滚动和焦点，选择随刷新和备份恢复。增强 LRC 与 WebVTT 会保留明确的词结束时间。

「设置 → 音频」和同步歌词入口均可调整歌词时间。全局设置可以按 100 毫秒提前、延后或自行输入，正值延后显示。调整后逐行、逐字、迷你歌词和点击跳转使用相同时间。 [Cotton Music 歌词时间配置](https://github.com/pure-music/PureMusic/releases/tag/v3.8.0)

在「设置 → 音频」开启「切到后台时暂停播放」，浏览器隐藏页面时会暂停，保留队列和播放进度。返回页面后可继续。这项设置默认关闭。 [Cotton Music 后台播放配置](https://github.com/pure-music/PureMusic/releases/tag/v3.8.0)

在「设置 → 音频」开启「向媒体服务器报告播放完成」后，Navidrome、OpenSubsonic 和 Subsonic 曲目自然播放结束时会向服务端提交播放记录。每次自然结束单独计数，手动切歌不会提交。 [OpenSubsonic 播放回传](https://opensubsonic.github.io/docs/endpoints/scrobble/)

开启「向 Emby 报告播放状态」后，可在 Emby 仪表盘查看正在播放的歌曲、暂停和进度。播放自然结束时清除活动会话，并由 Emby 更新播放次数。此选项默认关闭。 [Emby 播放回传](https://dev.emby.media/doc/restapi/Playback-Check-ins.html)

打开有专辑信息的艺人详情，可使用「查找艺人照片」。播放器用 MusicBrainz 核对艺人身份，通过 Wikidata 查找 Wikimedia Commons 图片，并在照片旁显示来源、署名及许可证。在「设置 → 曲库」开启「自动查找艺人照片」后，进入艺人详情也会尝试查找照片。歌曲封面与艺人照片的自动查找分别控制，新配置默认均开启；旧版明确保存的图片自动查找偏好会迁移到两个开关。关闭开关会取消对应自动请求，手动查找仍可用。在艺人详情点「停用自动匹配图片」，可暂停该艺人照片及专辑封面的自动查询，仍可手动查找。 [Wikidata 图片字段](https://www.wikidata.org/wiki/Property:P18) · [Wikimedia Commons 署名规则](https://commons.wikimedia.org/wiki/Commons:Reusing_content_outside_Wikimedia)

在「设置 → 曲库」关闭「自动查找艺人照片」并开启「缺少艺人照片时使用专辑封面」后，艺人列表和详情可使用该艺人首张可用的专辑封面。有可用的艺人照片时优先使用照片。回退开关在新配置中默认开启，旧版明确保存的选择会保留，可随本机设置备份恢复。 [Cotton Music 4.9.0](https://github.com/pure-music/PureMusic/releases/tag/v4.9.0)

## 连接百度网盘

1. 在百度网盘开放平台创建具备所需网盘接口权限的应用。百度官方说明，正式接入须申请企业开发者资格。[百度开放平台](https://pan.baidu.com/union/) · [百度接入说明](https://github.com/baidu-netdisk/mcp#一企业开发者接入)
2. 打开 [本机播放器的音乐来源](http://localhost:5187/#sources)，选择「百度网盘 → 在网页配置百度应用」。填写应用 ID 和应用密钥。保存后立即生效。
3. 点「使用百度设备授权 → 打开百度设备授权页面」，在百度页面输入播放器显示的设备码，登录并同意授权。保留播放器的授权弹窗，等待自动连接。也可使用「百度授权码」方式，在播放器内填入百度确认授权后显示的一次性授权码。
4. 连接后可浏览文件夹、播放音乐和扫描曲库。完成一次完整扫描后，可用「只扫描新目录」增量收录新建文件夹。

百度网盘开放平台禁止本地回调地址。本机使用百度官方的设备授权或授权码模式。公开 HTTPS 部署可以在百度应用的安全设置登记回调地址，并设置 `BAIDU_CLIENT_ID`、`BAIDU_CLIENT_SECRET` 和 `BAIDU_REDIRECT_URI`。部署后从同一 HTTPS 域名打开播放器。[百度回调限制](https://help.baidu.com/question?class=0&id=1002108&prod_id=257) · [百度设备授权接口](https://github.com/baidu-netdisk/mcp/blob/main/src/baidu-netdisk/openapi_client/api/auth_api.py) · [百度授权码模式](https://openauth.baidu.com/doc/doc.html)

遇到 `redirect_uri_mismatch` 时，本机可改用设备授权。公开 HTTPS 部署可在连接窗口核对完整回调地址，必要时点「从回调地址的域名打开播放器」。百度说明，安全设置里的回调地址更改可能需要一小时生效。[百度回调排查](https://help.baidu.com/question?class=0&id=1002104&prod_id=257)

网页提交的应用配置加密保存在 `.groovebox/baidu-settings.enc`，密钥保存在本机服务端。所有网盘的授权会话都可加密恢复。已用百度真实授权页验证能进入登录，真实账号的授权后目录和播放仍需验收。

### 百度网盘歌单备份

使用已获百度批准读写的应用，在服务端设置 `BAIDU_CLIENT_ID` 和 `BAIDU_BACKUP_APP_FOLDER`。目录值为百度分配的精确路径，例如 `/apps/Groovebox`，当前授权应用须与配置的应用 ID 一致。重启后在「音乐来源」的百度网盘卡片或目录工具栏打开「歌单备份」。确认上传后，播放器在应用目录下的 `groovebox-backups` 保存一份独立快照。首次上传时会尝试创建该子目录。 [百度网盘官方 SDK](https://github.com/baidu-netdisk/baidu-drive-sdk-go)

恢复时先预览，再合并到本机歌单与收藏，保留现有曲目及磁盘上的音频。播放器会核实该账号仍可访问的百度曲目。旧曲目可重新扫描确认归属。快照包含歌单名称、曲目顺序、收藏及用于恢复的曲目信息。上传结果未确认时，同一标签页刷新后仍可重试同一个快照。更换百度应用或轮换该应用密钥会改变账号绑定，旧备份须使用原绑定读取。

百度、Google Drive、Dropbox 和 OneDrive 的备份在包含已知歌单修改时间时使用版本 3；只有创建时间时使用版本 2，无已知日期时仍生成版本 1。本版本可恢复三种格式，旧版播放器可能无法读取较新的格式。已有待重试备份保留原始内容，即使歌单后来发生修改，重试仍提交原来的快照。

当前通过模拟百度接口验证，真实写入需在获批应用上验收。默认关闭备份，普通百度网盘连接继续可用。

## 连接其他网盘

在对应服务创建 Web OAuth 应用，在其管理后台登记回调 URI，并将应用 ID 和密钥填入 `.env` 对应字段。在与回调相同的浏览器地址打开播放器，然后在「音乐来源」授权。

Google Drive 歌单备份默认关闭。部署时设置 `GDRIVE_PLAYLIST_BACKUP=1`，连接 Google Drive 后在来源卡片点「歌单备份」，再为同一个账号单独同意 `drive.file` 权限。确认上传会在该账号的私人「Groovebox Playlist Backups」目录保存快照。恢复先预览可恢复曲目，再把歌单和收藏合并到本机。较早扫描的 Google Drive 曲目可重扫以更新账号归属。备份流程已通过模拟 Google 接口验收，真实账号授权及写入仍待验证。 [Google 增量授权](https://developers.google.com/identity/protocols/oauth2/web-server) · [Google Drive 文件创建](https://developers.google.com/workspace/drive/api/guides/create-file)

Dropbox 歌单备份默认关闭。设置 `DROPBOX_PLAYLIST_BACKUP=1` 后，可在来源卡片进入「歌单备份」并单独授予 `account_info.read` 和 `files.content.write`。旧连接缺少账号标识时会提示重新连接，再申请备份权限。确认上传会将快照保存到此应用可访问的独立目录，恢复前可预览并验证曲目。应用控制台的 App Folder 或 Full Dropbox 配置决定授权范围。真实账号授权及写入待验收。 [Dropbox 授权文档](https://docs.dropboxapi.com/dropbox-api/docs/get-started/authorization)

OneDrive 个人账号的歌单备份默认关闭。设置 `ONEDRIVE_PLAYLIST_BACKUP=1` 后，连接个人 OneDrive，在来源卡片的「歌单备份」中单独同意 `Files.ReadWrite.AppFolder`。程序核实播放授权与备份授权属于同一个账号及网盘，再读取应用文件夹。微软在首次访问时会创建 `Apps/应用名` 目录。确认上传保存独立快照，恢复前预览并核实可播放曲目，再合并歌单、收藏及创建日期。普通播放继续使用独立的只读凭据。 [微软应用文件夹](https://learn.microsoft.com/en-us/graph/onedrive-sharepoint-appfolder)

OneDrive 流程已通过模拟 Microsoft OAuth 和 Graph 的实际本地接口测试，覆盖账号变化、权限续期、上传冲突及结果不明后的原内容重试。真实个人账号的应用文件夹上传权限、冲突行为及写入仍待验收，工作或学校账号的备份尚未接入。 [微软上传会话](https://learn.microsoft.com/en-us/graph/api/driveitem-createuploadsession?view=graph-rest-1.0)

| 网盘 | `.env` 前缀 | 本机回调示例 | 权限设置 |
| --- | --- | --- | --- |
| Google Drive | `GDRIVE_` | `http://localhost:5187/api/gdrive/callback` | 启用 Drive API，配置 OAuth 同意界面和测试用户。生产接入可能需要验证 `drive.readonly` 范围 |
| OneDrive | `ONEDRIVE_` | `http://localhost:5187/api/onedrive/callback` | 使用 Microsoft Entra Web 应用，注册时选择组织目录和个人 Microsoft 账号，委派权限为 `Files.Read` |
| 阿里云盘 | `ALIYUNDRIVE_` | `http://localhost:5187/api/aliyundrive/callback` | 使用自己的开放平台应用，申请 `user:base,file:all:read` |
| 115 网盘 | `DRIVE115_` | `http://localhost:5187/api/drive115/callback` | 使用获批 115 开放平台应用，真实可用性受官方维护影响 |
| 光鸭云盘 | `GUANGYA_` | `http://localhost:5187/api/guangya/callback` | 申请 Web OAuth 客户端，使用 PKCE，仅需客户端 ID 和回调地址 |
| 123 云盘 | `DRIVE123_` | `http://localhost:5187/api/drive123/callback` | 使用获批第三方挂载应用。平台固定授权包含写权限，播放器仅调用官方读取接口 |
| Box | `BOX_` | `http://localhost:5187/api/box/callback` | Box 应用启用读取文件与文件夹的权限 |
| pCloud | `PCLOUD_` | `http://localhost:5187/api/pcloud/callback` | pCloud Web OAuth 应用。授权后自动使用美国或欧洲区域 API |
| Dropbox | `DROPBOX_` | `http://localhost:5187/api/dropbox/callback` | 启用 `files.metadata.read` 和 `files.content.read`，浏览整盘需选 Full Dropbox 类型 |

按表格设置应用凭据和回调。除使用 PKCE 的光鸭云盘外，各前缀后填写 `CLIENT_ID`、`CLIENT_SECRET` 和 `REDIRECT_URI`。默认从 [http://localhost:5187](http://localhost:5187) 打开。连接会话和浏览器存储均按主机区分。
[Google Drive 权限](https://developers.google.com/workspace/drive/api/guides/api-specific-auth) · [Microsoft Graph 音频下载](https://learn.microsoft.com/en-us/graph/api/driveitem-get-content?view=graph-rest-1.0) · [Dropbox OAuth](https://developers.dropbox.com/oauth-guide)

## 连接自建媒体服务器

在「音乐来源」选择「添加媒体服务器」，填写协议、服务地址和对应凭据。

| 协议 | 登录方式 |
| --- | --- |
| WebDAV | 匿名访问或 Basic 用户名和密码 |
| Subsonic、OpenSubsonic、Navidrome | 用户名和密码 |
| Jellyfin、Emby | 用户名和密码，或访问令牌。也可以提供对应用户 ID |
| Plex | Plex 账号登录，或手动填写服务器地址和 Plex 访问令牌 |
| SMB 2 / 3 | 填写 `smb://主机/共享名[/子目录]` 和共享账号、密码。需要安装下文的 Python 依赖 |
| Songloft | Songloft 服务器的用户名和密码，可浏览歌曲、读取封面和歌词 |
| 飞牛音乐（音桥） | 通过已连接音乐账号的音桥 OpenSubsonic 服务接入，默认端口 14040。使用已绑定的飞牛音乐独立账号，支持艺人和专辑封面、同步歌词及分段播放 |
| Kodi | 开启 Kodi 的「允许通过 HTTP 远程控制」，填写 Kodi 的 HTTP 地址和对应用户名、密码 |

选择 Plex 后，点击「使用 Plex 账号登录」，在 Plex 官方页面授权，再回到播放器选择可访问的服务器。知道服务器地址时可在授权前填写，播放器优先显示匹配的连接。 [Plex 开发者文档](https://developer.plex.tv/pms/)

媒体服务器连接入口供本机浏览器使用，由 Node 服务访问设备可连接的 HTTP(S) 媒体地址。连接凭据和已发布的目录、音频、封面、歌词标识加密保存在服务端的 `.groovebox/source-sessions/`。同一浏览器在会话有效期内可跨服务重启恢复原链接，无需重新扫描。媒体服务器密码和令牌不进入浏览器存储或导出的歌单备份。

会话沿用 7 天有效期，到期或清除浏览器 Cookie 后需要重新连接。不同浏览器的连接保持隔离，断开最后一个来源会撤销旧会话。首次升级前保存在内存中的旧连接需要重新添加一次，此后才可加密恢复。保存文件损坏或暂时不可读时，「音乐来源」会显示提示，可重试或重新添加。每个数据目录只运行一个 Node 服务进程。

Kodi 会显示已扫描入库的专辑和单曲，并通过 Kodi HTTP 服务播放。WebDAV 支持同目录 LRC/VTT 歌词。连接有写权限的 WebDAV 目录后，可在「云端歌单」上传歌单和收藏，或在另一台设备下载合并。开启「自动同步」后，播放器会在页面打开时同步歌单增删、改名和收藏，共享目录需支持 ETag 条件写入。

### SMB 依赖

在项目目录运行下列命令。Python 需为 3.10 或更新版本。

```sh
python3 -m venv .venv-smb
.venv-smb/bin/python -m pip install smbprotocol==1.17.0
```

服务器默认识别项目的 `.venv-smb`，也可用 `SMB_PYTHON` 指定解释器。若需要强制使用 SMB 加密，在 `.env` 设置 `SMB_REQUIRE_ENCRYPTION=1`。本机通过实际 SMB2 服务和要求加密的 Samba SMB3 服务验收。独立 NAS 硬件仍待实测。

## 功能范围与验证

| 功能 | 当前状态 |
| --- | --- |
| 本地曲库和播放 | 文件、文件夹导入与标签读取，封面、LRC/VTT 同步及逐字歌词、LRCLIB 在线匹配、播放与拖动、随机和循环、可排序队列 |
| 曲库管理 | 歌曲搜索，专辑、艺人和流派分组，云端内置标签分段读取，Shift 范围选曲和批量加入歌单，歌单手动排序和 M3U 导入，收藏、最近及常听记录，JSON 备份及 HTTP/HTTPS WebDAV 同步 |
| 播放器设置 | 深浅主题及跟随系统、背景、沉浸式播放器、播放速率、均衡器、曲目或专辑 ReplayGain，以及受支持浏览器中的播放时屏幕常亮 |
| 网盘与自建媒体服务器 | 网盘 OAuth、只读文件访问、目录扫描、Range 音频串流和同名歌词有模拟测试。WebDAV、Emby、Jellyfin、Navidrome、Subsonic、Kodi、Songloft 和 SMB 已进行实际服务集成测试，各来源详见验收清单 |
| 离线歌曲 | 在云端曲目的菜单选择「离线保存」，单首上限 60 MB。网盘失联后仍可从同一浏览器播放本地副本 |
| 投屏 | 支持浏览器 Remote Playback、Safari AirPlay 和局域网 DLNA。已用真实 GMediaRender 软件接收器验证发现设备、发送音频、播放、暂停、停止和调整进度，单首上限 60 MB。实体接收设备仍待验收 |
| Cotton Music 完整功能验收 | 参见 [逐项验收清单](PARITY.md) |

本地音频文件保存在当前浏览器的 IndexedDB 中，歌单、播放历史和设置也保存在本机。JSON 备份包含曲目引用、歌单、收藏、历史和设置，音频文件及网盘凭据需各自重新导入或授权。

在「最近播放 → 播放时光机」查看按日期和时间排列的最近 1,500 次播放。可单独导出播放记录，在另一个浏览器导入并与已有记录合并。

功能参照来自原版官网、开发者的公开项目说明与商店更新记录。[Cotton Music 官网](https://music.caij.xyz/en/) · [开发者功能说明](https://github.com/pure-music/PureMusic/blob/main/README_ZH.md) · [App Store](https://apps.apple.com/cn/app/id6752617064)

## 复跑测试

```sh
npm test
npm run test:e2e
```

后端测试覆盖 OAuth 状态校验、会话隔离、令牌刷新、中文路径与分页、Range 串流，以及媒体服务器的登录、目录和音频代理。Playwright 独立启动测试服务验证浏览器播放、曲库操作、刷新恢复、移动布局和模拟百度网盘。浏览器测试还验证了云端同名歌词、歌单同步和离线串流。测试优先使用本机已安装的 Chrome。要运行 WebKit，用 `npx playwright install webkit` 安装后运行 `PLAYWRIGHT_WEBKIT=1 npm run test:e2e -- --project webkit`。Firefox 可用 `npx playwright install firefox` 以及 `PLAYWRIGHT_FIREFOX=1 npm run test:e2e -- --project firefox --project firefox-mobile`。没有 Chrome 时，先运行 `npx playwright install chromium`。真实 SMB2 回归需另装 `impacket==0.13.0`，并用 `SMB_TEST_PYTHON` 指向包含 `smbprotocol` 和 `impacket` 的测试解释器。

真实服务集成测试使用独立的临时账号和目录。运行 `test/real-webdav.spec.mjs` 时，把 `GROOVEBOX_WEBDAV_TEST_PYTHON` 指向装有 WsgiDAV 和 Cheroot 的 Python。运行 `test/navidrome-live.spec.mjs` 或 `test/jellyfin-live.spec.mjs` 时，用 `NAVIDROME_TEST_BIN` 或 `JELLYFIN_TEST_BIN` 指向相应服务器，`FFMPEG_TEST_BIN` 指向 FFmpeg。Jellyfin FFmpeg 同目录需有 ffprobe。

本机 macOS 26.5 与 Playwright 1.65.1 的 WebKit 鼠标测试需要显示器处于唤醒状态。已复现显示器休眠后，原生鼠标事件坐标偏移，空白页面也会点击失败。可在测试期间使用有时限的 `caffeinate -d -u -t 120` 保持显示器唤醒，无需修改系统电源设置。

运行 `test/emby-live.spec.mjs` 时，将 `EMBY_TEST_IMAGE` 指向本机拉取的官方 Emby 镜像（已验收 `emby/embyserver:4.10.2.0`），并设置 `FFMPEG_TEST_BIN`。测试创建临时曲库，通过 Emby 的图片接口设置专辑封面，再验证曲库、歌词和音频播放。 [Emby 音乐库文档](https://www.emby.media/support/articles/Music-Naming.html)

真实 DLNA 软件接收器验证使用 `DLNA_TEST_IMAGE`，镜像入口应为 Debian 软件包的 `gmediarender`，并包含 GStreamer 的基础插件和常用插件。测试在独立 Docker 网络中发现接收器、投送 WAV 并验证控制命令。 [GMediaRender 软件包](https://packages.debian.org/trixie/gmediarender)

运行 `test/fnmusic-live.spec.mjs` 需要容器能通过 `host.docker.internal` 访问主机，例如 Docker Desktop。用 `YINQIAO_TEST_IMAGE` 指定本机 Docker 镜像，镜像入口须为发布包里的 `yinqiao-service`（Linux amd64）。测试启动真实的音桥服务和模拟的底层 API，验证浏览器接入、封面、同步歌词和音频范围请求。 [音桥发布包](https://github.com/qianlipp/fn-music-bridge/releases)

运行 `test/subsonic-live.spec.mjs` 时，使用本机独立的 Subsonic 测试实例，设置 `GROOVEBOX_SUBSONIC_TEST_URL` 和 `GROOVEBOX_SUBSONIC_TEST_AUDIO`。测试库须包含已索引、带标签的 `Fixture Artist / Fixture Album / Fixture Track.m4a`，并保留临时测试账户 `admin/admin`。 [Subsonic 独立版安装说明](https://www.subsonic.org/pages/installation.jsp)

`test/navidrome-playlists-live.spec.mjs` 和 `test/navidrome-live.spec.mjs` 均用 `NAVIDROME_TEST_BIN` 与 `FFMPEG_TEST_BIN` 启动临时曲库，分别验证服务器歌单原有顺序、重复曲目，以及手动切歌与自然播放结束的计数行为。`test/navidrome-lyric-versions-live.spec.mjs` 使用相同配置，生成包含三种语言内嵌歌词的 MP3，验证实际接口、播放和切换版本。FFmpeg 须支持 `libmp3lame`。

`test/smb-filename-live.spec.mjs` 使用 `SMB_TEST_PYTHON` 启动独立的只读 SMB2 共享，验证不同来源的文件名规则、标签切换、重新扫描、歌词、字节范围和已有歌单引用，并比对源文件未被修改。

用 HTTPS 验证 `test/real-webdav.spec.mjs` 时，设置 `GROOVEBOX_WEBDAV_TEST_PYTHON` 指向安装了 WsgiDAV 和 Cheroot 的 Python，提供 `127.0.0.1` 的测试证书与密钥 `GROOVEBOX_WEBDAV_TEST_CERT` 和 `GROOVEBOX_WEBDAV_TEST_KEY`，并通过 `NODE_EXTRA_CA_CERTS` 信任签发它的测试 CA。

运行 `test/songloft-live.spec.mjs` 时，用 `GROOVEBOX_SONGLOFT_TEST_URL` 和 `GROOVEBOX_SONGLOFT_TEST_AUDIO` 指定隔离的 Songloft 测试实例和原始 M4A。测试实例须先索引带封面、歌词和测试标签的曲目，具体标签和临时账号见测试文件。 [Songloft 自托管说明](https://github.com/songloft-org/songloft/blob/main/README.en.md)

真实 Songloft 远程音源续期测试使用 `GROOVEBOX_SONGLOFT_REMOTE_TEST_URL` 和 `GROOVEBOX_SONGLOFT_REMOTE_TEST_AUDIO`，测试库需要预先注册一个合成的远程 M4A。测试只缩短登录响应声明的有效期，验证官方服务签发的新令牌可继续浏览和分段播放。

运行 `test/kodi-live.spec.mjs` 时，用 `KODI_TEST_IMAGE` 指定带虚拟 X11 显示的 Kodi 镜像，`FFMPEG_TEST_BIN` 指向 FFmpeg。测试在临时目录创建 Kodi 曲库并扫描合成的 FLAC，验证认证、封面与字节范围。 [Kodi 21.2 Debian 软件包](https://packages.debian.org/trixie/kodi)

运行 `test/quality-formats-live.spec.mjs` 时设置 `FFMPEG_PATH`，用于生成 WAV 和验证 FLAC。追加 `MONKEY_AUDIO_TEST_BIN` 指向 Monkey’s Audio 命令行编码器，可运行真实 APE 转换及 PCM 样本比对。
