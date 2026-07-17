import { Table, View } from 'typeorm';
import { SnakeNamingStrategy } from 'typeorm-naming-strategies';

/**
 * Snake-case naming + meaningful constraint/index names (pk_*, fk_*, uq_*, idx_*, …) for easier
 * schema debugging. House standard, copied from rs-crm-app/cubix-infra/mls-studio.
 */
export class CustomNamingStrategy extends SnakeNamingStrategy {
  getTableName(tableOrName: Table | View | string): string {
    return typeof tableOrName === 'string' ? tableOrName : tableOrName.name;
  }

  primaryKeyName(tableOrName: Table | string): string {
    return `pk_${this.getTableName(tableOrName)}`;
  }

  uniqueConstraintName(tableOrName: Table | string, columnNames: string[]): string {
    return `uq_${this.getTableName(tableOrName)}_${columnNames.join('_')}`;
  }

  relationConstraintName(tableOrName: Table | string, columnNames: string[]): string {
    return `rel_${this.getTableName(tableOrName)}_${columnNames.join('_')}`;
  }

  foreignKeyName(
    tableOrName: Table | string,
    columnNames: string[],
    referencedTablePath?: string,
  ): string {
    return `fk_${this.getTableName(tableOrName)}_${columnNames.join('_')}_${referencedTablePath ?? 'ref'}`;
  }

  indexName(tableOrName: Table | View | string, columns: string[]): string {
    return `idx_${this.getTableName(tableOrName)}_${columns.join('_')}`;
  }

  defaultConstraintName(tableOrName: Table | string, columnName: string): string {
    return `df_${this.getTableName(tableOrName)}_${columnName}`;
  }

  checkConstraintName(tableOrName: Table | string, expression: string): string {
    return `chk_${this.getTableName(tableOrName)}_${this.shortHash(expression)}`;
  }

  exclusionConstraintName(tableOrName: Table | string, expression: string): string {
    return `excl_${this.getTableName(tableOrName)}_${this.shortHash(expression)}`;
  }

  private shortHash(str: string): string {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      hash = (hash << 5) - hash + str.charCodeAt(i);
      hash = hash & hash;
    }
    return Math.abs(hash).toString(36).substring(0, 8);
  }
}
