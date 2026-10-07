import { applyDecorators } from "@nestjs/common";
import { Transform, Type } from "class-transformer";
import { IsBoolean, IsInt, IsNotEmpty, IsNumber, IsObject, IsOptional, IsPositive, IsString, Max, Min, ValidateNested } from "class-validator";

export function AirportField(name: string) {
  return applyDecorators(
    Transform(({ value }) => (typeof value === "string" ? value.toUpperCase() : value)),
    IsString({ message: `O campo ${name} deve ser texto.` }),
    IsNotEmpty({ message: `O campo ${name} é obrigatório.` }),
  );
}

export function OptionalCeilingField(name: string) {
  return applyDecorators(
    IsOptional(),
    IsNumber({}, { message: `O campo ${name} deve ser um número.` }),
    IsPositive({ message: `O campo ${name} deve ser maior que zero.` }),
  );
}

export function OptionalBooleanField(name: string) {
  return applyDecorators(IsOptional(), IsBoolean({ message: `O campo ${name} deve ser verdadeiro ou falso.` }));
}

export function OptionalIntField(name: string, min: number, max: number) {
  const message = `O campo ${name} deve ser um inteiro entre ${min} e ${max}.`;
  return applyDecorators(IsOptional(), IsInt({ message }), Min(min, { message }), Max(max, { message }));
}

export function OptionalNestedField(name: string, type: () => new () => object) {
  return applyDecorators(
    IsOptional(),
    IsObject({ message: `O campo ${name} deve ser um objeto.` }),
    ValidateNested(),
    Type(type),
  );
}

export class RouteRequestDto {
  @AirportField("origin")
  origin!: string;

  @AirportField("destination")
  destination!: string;

  // Asks for a recent identical result instead of a new search. Never part of
  // what makes two searches the same.
  @OptionalBooleanField("reuseRecent")
  reuseRecent?: boolean;
}
