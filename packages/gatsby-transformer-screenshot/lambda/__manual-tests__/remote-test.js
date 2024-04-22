const SCREENSHOT_ENDPOINT = process.env.SCREENSHOT_ENDPOINT
const url = process.env.SITE_URL

const start = async () => {
  let screenshotResponse
  try {
    screenshotResponse = await fetch({
      type: `POST`,
      url: SCREENSHOT_ENDPOINT
    }, { url })
    const { status, data /* , headers */ } = screenshotResponse
    console.log(status)
    console.log(data)
  } catch (error) {
    console.log(error)
    console.log(screenshotResponse)
  }
}

start()
