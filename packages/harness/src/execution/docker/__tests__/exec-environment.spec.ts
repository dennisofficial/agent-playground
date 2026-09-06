import { describe, expect, it } from 'bun:test'

import { execEnvFor } from '../exec-environment'

describe('execEnvFor', () => {
  it('replaces host temporary directories with /tmp when the image has none', () => {
    expect(
      execEnvFor({
        requested: {
          TMPDIR: '/var/folders/host/T/',
          TMP: '/host/tmp',
          TEMP: '/host/temp',
        },
        imageEnv: [],
      }),
    ).toEqual({ TMPDIR: '/tmp', TMP: '/tmp', TEMP: '/tmp' })
  })

  it('uses each image temporary directory instead of the host value', () => {
    expect(
      execEnvFor({
        requested: { TMPDIR: '/var/folders/host/T/', TMP: '/host/tmp', TEMP: '/host/temp' },
        imageEnv: ['TMPDIR=/var/tmp/build=1', 'TMP=/run/tmp', 'TEMP=/var/tmp'],
      }),
    ).toEqual({ TMPDIR: '/var/tmp/build=1', TMP: '/run/tmp', TEMP: '/var/tmp' })
  })

  it('retains container identity paths despite conflicting host settings', () => {
    const env = execEnvFor({
      requested: {
        HOME: '/Users/host',
        GNUPGHOME: '/Users/host/.gnupg',
        SSH_AUTH_SOCK: '/private/tmp/host-agent.sock',
      },
      imageEnv: [
        'HOME=/home/operator',
        'GNUPGHOME=/run/atlas/gnupg',
        'SSH_AUTH_SOCK=/run/atlas/ssh-agent.sock',
      ],
    })

    expect(env).toMatchObject({
      HOME: '/home/operator',
      GNUPGHOME: '/run/atlas/gnupg',
      SSH_AUTH_SOCK: '/run/atlas/ssh-agent.sock',
    })
  })

  it('replaces host git configuration as a unit and removes stale indexed pairs', () => {
    const env = execEnvFor({
      requested: {
        GIT_CONFIG_COUNT: '4',
        GIT_CONFIG_KEY_0: 'safe.directory',
        GIT_CONFIG_VALUE_0: '*',
        GIT_CONFIG_KEY_1: 'gpg.program',
        GIT_CONFIG_VALUE_1: '/opt/homebrew/bin/gpg',
        GIT_CONFIG_KEY_2: 'safe.directory',
        GIT_CONFIG_VALUE_2: '*',
        GIT_CONFIG_KEY_3: 'user.name',
        GIT_CONFIG_VALUE_3: 'Host',
        GIT_CONFIG_KEY_12: 'safe.directory',
        GIT_CONFIG_VALUE_12: '*',
      },
      imageEnv: [
        'GIT_CONFIG_COUNT=3',
        'GIT_CONFIG_KEY_0=gpg.program',
        'GIT_CONFIG_VALUE_0=gpg',
        'GIT_CONFIG_KEY_1=safe.directory',
        'GIT_CONFIG_VALUE_1=/work/repo=1',
        'GIT_CONFIG_KEY_2=safe.directory',
        'GIT_CONFIG_VALUE_2=/work/repo=1/*',
      ],
    })

    expect(env).toEqual({
      TMPDIR: '/tmp',
      TMP: '/tmp',
      TEMP: '/tmp',
      GIT_CONFIG_COUNT: '3',
      GIT_CONFIG_KEY_0: 'gpg.program',
      GIT_CONFIG_VALUE_0: 'gpg',
      GIT_CONFIG_KEY_1: 'safe.directory',
      GIT_CONFIG_VALUE_1: '/work/repo=1',
      GIT_CONFIG_KEY_2: 'safe.directory',
      GIT_CONFIG_VALUE_2: '/work/repo=1/*',
    })
  })

  it('removes host git pairs when the image explicitly disables injected configuration', () => {
    const env = execEnvFor({
      requested: {
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'safe.directory',
        GIT_CONFIG_VALUE_0: '*',
      },
      imageEnv: ['GIT_CONFIG_COUNT=0'],
    })

    expect(env).toEqual({
      TMPDIR: '/tmp',
      TMP: '/tmp',
      TEMP: '/tmp',
      GIT_CONFIG_COUNT: '0',
    })
  })

  it('preserves ordinary request variables, including empty values, without mutating inputs', () => {
    const requested = Object.freeze({
      NODE_ENV: 'development',
      PORT_MARKER: 'forwarded',
      EMPTY: '',
      UNSET: undefined,
      GIT_CONFIG_GLOBAL: '/work/gitconfig',
    })
    const imageEnv = Object.freeze(['NODE_ENV=production', 'IMAGE_ONLY=not-an-exec-override'])

    expect(execEnvFor({ requested, imageEnv })).toEqual({
      NODE_ENV: 'development',
      PORT_MARKER: 'forwarded',
      EMPTY: '',
      GIT_CONFIG_GLOBAL: '/work/gitconfig',
      TMPDIR: '/tmp',
      TMP: '/tmp',
      TEMP: '/tmp',
    })
    expect(requested.UNSET).toBeUndefined()
    expect(Object.keys(requested)).toEqual([
      'NODE_ENV', 'PORT_MARKER', 'EMPTY', 'UNSET', 'GIT_CONFIG_GLOBAL',
    ])
    expect(imageEnv).toEqual(['NODE_ENV=production', 'IMAGE_ONLY=not-an-exec-override'])
  })

  it.each([
    {
      name: 'replaces a host PATH with the image PATH',
      requested: { PATH: '/host/bin' },
      imageEnv: ['PATH=/usr/local/bin:/usr/bin'],
      expected: '/usr/local/bin:/usr/bin',
    },
    {
      name: 'keeps the requested PATH when the image has none',
      requested: { PATH: '/host/bin' },
      imageEnv: [],
      expected: '/host/bin',
    },
    {
      name: 'leaves an omitted PATH to container inheritance',
      requested: {},
      imageEnv: ['PATH=/usr/bin'],
      expected: undefined,
    },
    {
      name: 'leaves an undefined PATH to container inheritance',
      requested: { PATH: undefined },
      imageEnv: ['PATH=/usr/bin'],
      expected: undefined,
    },
  ])('$name', ({ requested, imageEnv, expected }) => {
    expect(execEnvFor({ requested, imageEnv }).PATH).toBe(expected)
  })

  it('fills absent temporary variables independently from image settings and /tmp', () => {
    expect(execEnvFor({ requested: {}, imageEnv: ['TMP=/run/tmp'] })).toEqual({
      TMPDIR: '/tmp', TMP: '/run/tmp', TEMP: '/tmp',
    })
  })

  it('includes configured identity paths even when the request omits them', () => {
    expect(
      execEnvFor({
        requested: {},
        imageEnv: ['HOME=/home/operator', 'GNUPGHOME=/run/atlas/gnupg', 'SSH_AUTH_SOCK='],
      }),
    ).toMatchObject({
      HOME: '/home/operator', GNUPGHOME: '/run/atlas/gnupg', SSH_AUTH_SOCK: '',
    })
  })

  it('keeps requested identity and git settings when the container does not own them', () => {
    expect(
      execEnvFor({
        requested: {
          HOME: '/home/operator',
          GNUPGHOME: '/work/gnupg',
          SSH_AUTH_SOCK: '/work/agent.sock',
          GIT_CONFIG_COUNT: '1',
          GIT_CONFIG_KEY_0: 'user.name',
          GIT_CONFIG_VALUE_0: 'Operator',
        },
        imageEnv: [],
      }),
    ).toEqual({
      HOME: '/home/operator',
      GNUPGHOME: '/work/gnupg',
      SSH_AUTH_SOCK: '/work/agent.sock',
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'user.name',
      GIT_CONFIG_VALUE_0: 'Operator',
      TMPDIR: '/tmp',
      TMP: '/tmp',
      TEMP: '/tmp',
    })
  })
})
