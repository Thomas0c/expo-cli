/**
 * Copyright (c) 2021 Expo, Inc.
 * Copyright (c) 2021 Callstack, Inc.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * Based on https://github.com/callstack/repack/blob/3c1e059/packages/repack/src/webpack/plugins/AssetsPlugin/assetsLoader.ts
 */

import crypto from 'crypto';
import type fs from 'fs';
// @ts-ignore
import { imageSize } from 'image-size';
// @ts-ignore
import { ISizeCalculationResult } from 'image-size/dist/types/interface';
// @ts-ignore
import utils from 'loader-utils';
import path from 'path';
import validateSchema from 'schema-utils';
import { promisify } from 'util';

import { escapeStringRegexp } from '../../utils/escapeStringRegexp';
import { CollectedScales, NativeAssetResolver } from './NativeAssetResolver';

interface Options {
  platforms: string[];
  assetExtensions: string[];
  persist?: boolean;
  publicPath?: string;
}

function getOptions(loaderContext: any): Options {
  const options = utils.getOptions(loaderContext) || {};

  validateSchema(
    {
      type: 'object',
      required: ['platforms', 'assetExtensions'],
      properties: {
        platforms: {
          type: 'array',
          items: {
            type: 'string',
          },
        },
        assetExtensions: {
          type: 'array',
          items: {
            type: 'string',
          },
        },
        persist: { type: 'boolean' },
        publicPath: { type: 'string' },
      },
    },
    options,
    { name: 'nativeAssetsLoader' }
  );

  return (options as unknown) as Options;
}

export const raw = true;

function getAndroidResourceFolder({
  name,
  contents,
  scale,
  scaleFilePath,
}: {
  name: string;
  contents?: string;
  scale: string;
  scaleFilePath: string;
}) {
  const testXml = /\.(xml)$/;
  const testImages = /\.(png|jpg|gif|webp)$/;
  const testFonts = /\.(ttf|otf|ttc)$/;

  if (
    // found font family
    (testXml.test(name) && contents?.includes('font-family')) ||
    // font extensions
    testFonts.test(name)
  ) {
    return 'font';
  } else if (testImages.test(name) || testXml.test(name)) {
    // images extensions
    switch (scale) {
      case '@0.75x':
        return 'drawable-ldpi';
      case '@1x':
        return 'drawable-mdpi';
      case '@1.5x':
        return 'drawable-hdpi';
      case '@2x':
        return 'drawable-xhdpi';
      case '@3x':
        return 'drawable-xxhdpi';
      case '@4x':
        return 'drawable-xxxhdpi';
      default:
        throw new Error(`Unknown scale ${scale} for ${scaleFilePath}`);
    }
  }

  // everything else is going to RAW
  return 'raw';
}

export default async function nativeAssetsLoader(this: any) {
  this.cacheable();

  const callback = this.async();
  const logger = this.getLogger('nativeAssetsLoader');
  const rootContext = this.rootContext;

  logger.debug('Processing:', this.resourcePath);

  try {
    const options = getOptions(this);
    const pathSeparatorPattern = new RegExp(`\\${path.sep}`, 'g');
    const resourcePath = this.resourcePath;
    const dirname = path.dirname(resourcePath);
    // Relative path to rootContext without any ../ due to https://github.com/callstack/haul/issues/474
    // Assets from from outside of rootContext, should still be placed inside bundle output directory.
    // Example:
    //   resourcePath    = monorepo/node_modules/my-module/image.png
    //   dirname         = monorepo/node_modules/my-module
    //   rootContext     = monorepo/packages/my-app/
    //   relativeDirname = ../../node_modules/my-module (original)
    // So when we calculate destination for the asset for iOS ('assets' + relativeDirname + filename),
    // it will end up outside of `assets` directory, so we have to make sure it's:
    //   relativeDirname = node_modules/my-module (tweaked)
    const relativeDirname = path
      .relative(rootContext, dirname)
      .replace(new RegExp(`^[\\.\\${path.sep}]+`), '');
    const type = path.extname(resourcePath).replace(/^\./, '');
    const assetsPath = 'assets';
    const suffix = `(@\\d+(\\.\\d+)?x)?(\\.(${options.platforms.join('|')}))?\\.${type}$`;
    const filename = path.basename(resourcePath).replace(new RegExp(suffix), '');
    // Name with embedded relative dirname eg `node_modules_reactnative_libraries_newappscreen_components_logo.png`
    const normalizedName = `${(relativeDirname.length === 0
      ? filename
      : `${relativeDirname.replace(pathSeparatorPattern, '_')}_${filename}`
    )
      .toLowerCase()
      .replace(/[^a-z0-9_]/g, '')}.${type}`;

    const files = await new Promise<string[]>((resolve, reject) =>
      this.fs.readdir(dirname, (error: Error | null, results: any[]) => {
        if (error) {
          reject(error);
        } else {
          resolve(
            (results as any[] | undefined)?.filter(result => typeof result === 'string') ?? []
          );
        }
      })
    );

    const scales = NativeAssetResolver.collectScales(files, {
      name: filename,
      type,
      assetExtensions: options.assetExtensions,
      platforms: options.platforms,
    });

    const scaleKeys = Object.keys(scales).sort(
      (a, b) => parseInt(a.replace(/[^\d.]/g, ''), 10) - parseInt(b.replace(/[^\d.]/g, ''), 10)
    );
    const readFileAsync = promisify(this.fs.readFile.bind(this.fs) as typeof fs.readFile);

    const resolveAssetOutput = (results: any, scale: string, scaleFilePath: string) => {
      if (options.persist && options.platforms.includes('android')) {
        const destination = getAndroidResourceFolder({
          name: normalizedName,
          scale,
          scaleFilePath,
          contents: results,
        });
        return path.join(destination, normalizedName);
      }

      const name = `${filename}${scale === '@1x' ? '' : scale}.${type}`;
      return path.join(assetsPath, relativeDirname, name);
    };

    const resolveScaleAsync = async (
      scale: string
    ): Promise<{
      destination: string;
      content: string | Buffer | undefined;
    }> => {
      const scaleFilePath = path.join(dirname, scales[scale].name);
      this.addDependency(scaleFilePath);
      const results = await readFileAsync(scaleFilePath);
      return {
        content: results,
        destination: resolveAssetOutput(results, scale, scaleFilePath),
      };
    };

    const assets = await Promise.all(scaleKeys.map(resolveScaleAsync));

    assets.forEach(asset => {
      const { destination, content } = asset;

      logger.debug('Asset emitted:', destination);
      // Assets are emitted relatively to `output.path`.
      this.emitFile(destination, content ?? '');
    });

    let publicPath = path.join(assetsPath, relativeDirname).replace(pathSeparatorPattern, '/');

    if (options.publicPath) {
      publicPath = path.join(options.publicPath, publicPath);
    }

    const hashes = assets.map(asset =>
      crypto
        .createHash('md5')
        .update(asset.content?.toString() ?? asset.destination, 'utf8')
        .digest('hex')
    );

    let info: ISizeCalculationResult | undefined;

    try {
      info = imageSize(this.resourcePath);

      const match = path
        .basename(this.resourcePath)
        .match(new RegExp(`^${escapeStringRegexp(filename)}${suffix}`));

      if (match?.[1]) {
        const scale = Number(match[1].replace(/[^\d.]/g, ''));

        if (typeof scale === 'number' && Number.isFinite(scale)) {
          info.width && (info.width /= scale);
          info.height && (info.height /= scale);
        }
      }
    } catch {
      // Asset is not an image
    }

    logger.debug('Asset processed:', {
      resourcePath,
      platforms: options.platforms,
      rootContext,
      relativeDirname,
      type,
      assetsPath,
      filename,
      normalizedName,
      scales,
      assets: assets.map(asset => asset.destination),
      publicPath,
      width: info?.width,
      height: info?.height,
    });

    callback?.(
      null,
      createAssetCodeBlock({
        persist: !!options.persist,
        scales,
        filename,
        type,
        hashes,
        httpServerLocation: publicPath,
        fileSystemLocation: dirname,
        ...(info || {}),
      })
    );
  } catch (error) {
    callback?.(error);
  }
}

function createAssetCodeBlock({
  persist,
  scales,
  filename,
  type,
  hashes,
  httpServerLocation,
  height,
  width,
  fileSystemLocation,
}: {
  persist: boolean;
  scales: CollectedScales;
  filename: string;
  type: string;
  hashes: string[];
  httpServerLocation: string;
  height?: number;
  width?: number;
  fileSystemLocation: string;
}) {
  // Convert `{ "@1x": { ... } }` -> `[1]`
  const numericScales = Object.keys(scales)
    .map(scale => {
      const numericScale = scale.match(/@([\d|.]+)x/)?.[1];
      if (!numericScale) {
        return null;
      }
      try {
        return Number(numericScale);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  // TODO: `fileHashes`?
  return [
    `module.exports = require('react-native/Libraries/Image/AssetRegistry').registerAsset({`,
    `  __packager_asset: true,`,
    `  httpServerLocation: ${JSON.stringify(httpServerLocation)},`,
    // TODO: ??
    `${persist ? '' : `  fileSystemLocation: ${JSON.stringify(fileSystemLocation)},`}`,
    `  scales: ${JSON.stringify(numericScales)},`,
    `  hash: ${JSON.stringify(hashes.join())},`,
    `  name: ${JSON.stringify(filename)},`,
    `  type: ${JSON.stringify(type)},`,
    `${width != null ? `  width: ${width},` : ''}`,
    `${height != null ? `  height: ${height},` : ''}`,
    `});`,
  ]
    .filter(Boolean)
    .join('\n');
}
