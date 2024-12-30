import { EasyDebridClient } from '@paradise-cloud/easy-debrid';
import magnet from 'magnet-uri';
import { isVideo, isArchive } from '../lib/extension.js';
import { getMagnetLink } from '../lib/magnetHelper.js';
import { Type } from '../lib/types.js';
import { BadTokenError, chunkArray, sameFilename } from './mochHelper.js';
import StaticResponse from './static.js';

const KEY = 'easydebrid';

export async function getCachedStreams(streams, apiKey) {
    const options = await getDefaultOptions();
    const ED = new EasyDebridClient({ accessToken: apiKey, ...options })
    return Promise.all(chunkArray(streams, 100)
        .map(chunkedStreams => _getCachedStreams(ED, apiKey, chunkedStreams)))
        .then(results => {
            return results.reduce((all, result) => Object.assign(all, result), {})
        });
}
async function _getCachedStreams(ED, apiKey, streams) {
    const urls = streams.map(stream => magnet.encode({ infoHash: stream.infoHash }));
    return ED.linkLookup(urls)
        .catch(error => {
            if (toCommonError(error)) {
                return Promise.reject(error);
            }
            console.warn('Failed EasyDebrid cached torrent availability request:', error);
            return undefined;
        })
        .then(available => streams
            .reduce((mochStreams, stream, index) => {
                const streamTitleParts = stream.title.replace(/\n👤.*/s, '').split('\n');
                const fileName = streamTitleParts[streamTitleParts.length - 1];
                const fileIndex = streamTitleParts.length === 2 ? stream.fileIdx : null;
                const encodedFileName = encodeURIComponent(fileName);
                mochStreams[`${stream.infoHash}`] = {
                    url: `${apiKey}/${stream.infoHash}/${encodedFileName}/${fileIndex}`,
                    cached: available?.cached[index]
                };
                return mochStreams;
            }, {}));
}

export async function getCatalog(apiKey, offset = 0) {
    console.log('Getting EasyDebrid catalog:', offset);
    console.log(`Api key ${apiKey}`);
    if (offset > 0) {
        return [];
    }

    const options = await getDefaultOptions();

    // const cached = getCachedStreams([{ infoHash: 'test', title: 'test' }], apiKey)
    // console.log('Cached:', cached);



    return [];
    // const options = await getDefaultOptions();
    // const ED = new EasyDebridClient({ accessToken: apiKey, ...options });
    // return ED.folder.list()
    //     .then(response => response.content)
    //     .then(torrents => (torrents || [])
    //         .filter(torrent => torrent && torrent.type === 'folder')
    //         .map(torrent => ({
    //             id: `${KEY}:${torrent.id}`,
    //             type: Type.OTHER,
    //             name: torrent.name
    //         })));
}

export async function getItemMeta(itemId, apiKey, ip) {
    const options = await getDefaultOptions();
    const ED = new EasyDebridClient(apiKey, options);
    const rootFolder = await ED.folder.list(itemId, null);
    const infoHash = await _findInfoHash(ED, itemId);
    return getFolderContents(ED, itemId, ip)
        .then(contents => ({
            id: `${KEY}:${itemId}`,
            type: Type.OTHER,
            name: rootFolder.name,
            infoHash: infoHash,
            videos: contents
                .map((file, index) => ({
                    id: `${KEY}:${file.id}:${index}`,
                    title: file.name,
                    released: new Date(file.created_at * 1000 - index).toISOString(),
                    streams: [{ url: file.link || file.stream_link }]
                }))
        }))
}

async function getFolderContents(ED, itemId, ip, folderPrefix = '') {
    return ED.folder.list(itemId, null, ip)
        .then(response => response.content)
        .then(contents => Promise.all(contents
            .filter(content => content.type === 'folder')
            .map(content => getFolderContents(ED, content.id, ip, [folderPrefix, content.name].join('/'))))
            .then(otherContents => otherContents.reduce((a, b) => a.concat(b), []))
            .then(otherContents => contents
                .filter(content => content.type === 'file' && isVideo(content.name))
                .map(content => ({ ...content, name: [folderPrefix, content.name].join('/') }))
                .concat(otherContents)));
}

export async function resolve({ ip, isBrowser, apiKey, infoHash, cachedEntryInfo, fileIndex }) {
    console.log(`Unrestricting EasyDebrid ${infoHash} [${fileIndex}] for IP ${ip} from browser=${isBrowser}`);
    const options = await getDefaultOptions();
    const ED = new EasyDebridClient({ accessToken: apiKey, ...options });
    return _getCachedLink(ED, infoHash, cachedEntryInfo, fileIndex, ip, isBrowser)
        .catch(() => _resolve(ED, infoHash, cachedEntryInfo, fileIndex, ip, isBrowser))
        .catch(error => {
            if (error?.message?.includes('Account not premium.')) {
                console.log(`Access denied to EasyDebrid ${infoHash} [${fileIndex}]`);
                return StaticResponse.FAILED_ACCESS;
            }
            return Promise.reject(`Failed EasyDebrid adding torrent ${JSON.stringify(error)}`);
        });
}

async function _resolve(ED, infoHash, cachedEntryInfo, fileIndex, ip, isBrowser) {
    const torrent = await _createOrFindTorrent(ED, infoHash);
    if (torrent && statusReady(torrent.status)) {
        return _getCachedLink(ED, infoHash, cachedEntryInfo, fileIndex, ip, isBrowser);
    } else if (torrent && statusDownloading(torrent.status)) {
        console.log(`Downloading to EasyDebrid ${infoHash} [${fileIndex}]...`);
        return StaticResponse.DOWNLOADING;
    } else if (torrent && statusError(torrent.status)) {
        console.log(`Retrying downloading to EasyDebrid ${infoHash} [${fileIndex}]...`);
        return _retryCreateTorrent(ED, infoHash, cachedEntryInfo, fileIndex);
    }
    return Promise.reject(`Failed EasyDebrid adding torrent ${JSON.stringify(torrent)}`);
}

async function _getCachedLink(ED, infoHash, encodedFileName, fileIndex, ip, isBrowser) {
    const magnetLink = magnet.encode({ infoHash });
    const response = await ED.generateDebridLink(magnetLink);
    if (response?.files?.length) {
        const targetFileName = decodeURIComponent(encodedFileName);
        const videos = response.files.filter(file => isVideo(file.path));
        const targetVideo = Number.isInteger(fileIndex)
            ? videos.find(video => sameFilename(video.path, targetFileName))
            : videos.sort((a, b) => b.size - a.size)[0];
        if (!targetVideo && videos.every(video => isArchive(video.path))) {
            console.log(`Only EasyDebrid archive is available for [${infoHash}] ${fileIndex}`)
            return StaticResponse.FAILED_RAR;
        }
        const unrestrictedLink = targetVideo.url;
        console.log(`Unrestricted EasyDebrid ${infoHash} [${fileIndex}] to ${unrestrictedLink}`);
        return unrestrictedLink;
    }
    return Promise.reject('No cached entry found');
}

async function _createOrFindTorrent(ED, infoHash) {
    return _findTorrent(ED, infoHash)
        .catch(() => _createTorrent(ED, infoHash));
}

async function _findTorrent(ED, infoHash) {
    const torrents = await ED.transfer.list().then(response => response.transfers);
    const foundTorrents = torrents.filter(torrent => torrent.src.toLowerCase().includes(infoHash));
    const nonFailedTorrent = foundTorrents.find(torrent => !statusError(torrent.statusCode));
    const foundTorrent = nonFailedTorrent || foundTorrents[0];
    return foundTorrent || Promise.reject('No recent torrent found');
}

async function _findInfoHash(ED, itemId) {
    const torrents = await ED.transfer.list().then(response => response.transfers);
    const foundTorrent = torrents.find(torrent => `${torrent.file_id}` === itemId || `${torrent.folder_id}` === itemId);
    return foundTorrent?.src ? magnet.decode(foundTorrent.src).infoHash : undefined;
}

async function _createTorrent(ED, infoHash) {
    const magnetLink = await getMagnetLink(infoHash);
    return ED.transfer.create(magnetLink).then(() => _findTorrent(ED, infoHash));
}

async function _retryCreateTorrent(ED, infoHash, encodedFileName, fileIndex) {
    const newTorrent = await _createTorrent(ED, infoHash).then(() => _findTorrent(ED, infoHash));
    return newTorrent && statusReady(newTorrent.status)
        ? _getCachedLink(ED, infoHash, encodedFileName, fileIndex)
        : StaticResponse.FAILED_DOWNLOAD;
}

export function toCommonError(error) {
    if (error && error.message === 'Not logged in.') {
        return BadTokenError;
    }
    return undefined;
}

function statusError(status) {
    return ['deleted', 'error', 'timeout'].includes(status);
}

function statusDownloading(status) {
    return ['waiting', 'queued', 'running'].includes(status);
}

function statusReady(status) {
    return ['finished', 'seeding'].includes(status);
}

async function getDefaultOptions(ip) {
    return { timeout: 5000 };
}
