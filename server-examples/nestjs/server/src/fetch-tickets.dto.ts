import { plainToInstance, Transform, Type } from 'class-transformer';
import { IsArray, IsIn, IsInt, IsOptional, IsString, Min, ValidateNested } from 'class-validator';

const ALLOWED_COLUMNS = ['id', 'subject', 'status', 'priority', 'assignee', 'createdAt'] as const;
const ALLOWED_CONDITIONS = ['eq', 'neq', 'contains', 'not_contains', 'begins_with', 'ends_with', 'empty', 'not_empty'] as const;

export class FilterConditionDto {
  @IsIn(ALLOWED_COLUMNS)
  prop: string;

  @IsIn(ALLOWED_CONDITIONS)
  condition: string;

  @IsArray()
  @IsString({ each: true })
  value: string[];
}

export class SortDto {
  @IsIn(ALLOWED_COLUMNS)
  column: string;

  @IsIn(['asc', 'desc'])
  order: 'asc' | 'desc';
}

export class FetchTicketsDto {
  @IsInt()
  @Min(1)
  @Type(() => Number)
  page: number = 1;

  @IsInt()
  @Min(1)
  @Type(() => Number)
  pageSize: number = 10;

  @IsOptional()
  @ValidateNested()
  @Type(() => SortDto)
  sort?: SortDto;

  @IsOptional()
  @ValidateNested({ each: true })
  @Type(() => FilterConditionDto)
  @Transform(({ value }) => {
    const arr = Array.isArray(value) ? value : value ? [value] : [];
    return arr.map((item) => plainToInstance(FilterConditionDto, item));
  })
  filters?: FilterConditionDto[];
}
