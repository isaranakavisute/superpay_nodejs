export class AppError extends Error {
  constructor(
    message,
    { status = 500, code = 'internal_error', details } = {},
  ) {
    super(message);
    this.name = new.target.name;
    this.status = status;
    this.code = code;
    this.details = details;
    this.expected = status < 500;
  }
}

export class BadRequestError extends AppError {
  constructor(message = 'Bad request', details) {
    super(message, { status: 400, code: 'bad_request', details });
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'Not found', details) {
    super(message, { status: 404, code: 'not_found', details });
  }
}

export class ConflictError extends AppError {
  constructor(message = 'Conflict', details) {
    super(message, { status: 409, code: 'conflict', details });
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Unauthorized', details) {
    super(message, { status: 401, code: 'unauthorized', details });
  }
}
