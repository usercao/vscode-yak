exports.run = async () => {
  const { run } = await import('./extensionHost.mjs')
  await run()
}
