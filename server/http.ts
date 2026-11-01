/** Small shared HTTP error type so feature modules can return consistent statuses. */
export class HttpError extends Error {
  status: number

  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}
