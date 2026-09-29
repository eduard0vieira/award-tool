import { BadRequestException, ValidationPipe, type ValidationError } from "@nestjs/common";

function messagesOf(errors: ValidationError[]): string[] {
  return errors.flatMap((error) => [...Object.values(error.constraints ?? {}), ...messagesOf(error.children ?? [])]);
}

export function createValidationPipe(): ValidationPipe {
  return new ValidationPipe({
    transform: true,
    exceptionFactory: (errors) => new BadRequestException(messagesOf(errors).join(" ")),
  });
}

const pipe = createValidationPipe();

export function validateBody<T extends object>(dto: new () => T, body: unknown): Promise<T> {
  return pipe.transform(body ?? {}, { type: "body", metatype: dto });
}
